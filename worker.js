/**
 * ============================================================================
 *  Stremio <-> Nuvio Live Sync  ·  Cloudflare Worker (addon brain)
 * ============================================================================
 *
 *  WHAT THIS IS
 *  ------------
 *  A 100% stateless Stremio-compatible addon that bridges live playback
 *  position between Stremio and Nuvio.
 *
 *  Install ONE manifest URL in both apps:
 *
 *      https://<worker-host>/t/<nuvio-token>@<profile>/manifest.json
 *
 *  The `t/<token>` path prefix is how the user's identity travels: Stremio's
 *  HTTP transport derives every resource URL from the directory the manifest
 *  was installed from, so the prefix is automatically appended to every
 *  request that follows (`/t/<token>/player/movie/tt123/action=pause...`).
 *  No database, no cookies, no sessions - the token in the path IS the state.
 *
 *  HOW POSITION FLOWS (the gap this fills)
 *  ---------------------------------------
 *  Stremio's addon protocol defines *event* resources ("player", "library")
 *  where the addon RECEIVES the user's activity instead of serving data:
 *
 *      /player/{type}/{videoID}/{extraArgs}.json
 *          action=start&currentTime={ms}&duration={ms}   (start or resume)
 *          action=pause&currentTime={ms}&duration={ms}   (user paused)
 *          action=stop&currentTime={ms}&duration={ms}    (player closed,
 *                                                          video changed or
 *                                                          ended - INCLUDES
 *                                                          abrupt app exit)
 *
 *  We parse those query-style parameters straight out of the path and fire
 *  the value at Nuvio's sync API in the same request:
 *
 *      POST https://api.nuvio.tv/rest/v1/rpc/sync_push_watch_progress
 *      Authorization: Bearer <token from path>
 *      apikey: <Nuvio publishable client key>
 *      { p_profile_id, p_entries: [{ content_id, content_type, video_id,
 *                                    season, episode, position, duration,
 *                                    last_watched }] }
 *
 *  Nuvio auto-marks an item watched when position >= 90% of duration.
 *
 *  THE RETURN TRIP (Nuvio -> Stremio)
 *  ----------------------------------
 *  The addon also declares a catalog ("Continue Watching") that pulls the
 *  user's Nuvio progress and renders it as a row in Stremio - the same
 *  catalog mechanism that shows a Letterboxd watchlist in Stremio, but sourced
 *  from the Nuvio account instead.
 *
 *  PRIVACY: nothing is stored. The token is read from the request path and
 *  used for exactly one upstream call, then discarded.
 *
 *  DEPLOY
 *  ------
 *      npx wrangler deploy            (uses wrangler.toml in this folder)
 *      npx wrangler tail              (watch player events arrive, live)
 */

// ---------------------------------------------------------------------------
// CONFIGURATION
// ---------------------------------------------------------------------------

/**
 * Nuvio's publishable client key. This is a PUBLIC key - it ships inside
 * every Nuvio client (same role as a Supabase "anon" key) and only identifies
 * the app, never the user. Override with a wrangler secret/vars if it rotates.
 */
const NUVIO_PUBLISHABLE_KEY_DEFAULT = 'sb_publishable_1Clq8rlTVACkdcZuqr6_AD__xUUC_EN';

/** Nuvio API base - all sync RPCs live under {base}/rest/v1/rpc/... */
const NUVIO_BASE_DEFAULT = 'https://api.nuvio.tv';

/**
 * Stremio's account API (NOT the addon protocol - this is the same API the
 * Stremio apps themselves use). It is the only way to write a resume point
 * into a user's Stremio account: library items carry the position in
 * `state.timeOffset`, which the player reads to resume playback.
 */
const STREMIO_API_DEFAULT = 'https://api.strem.io/api';

/**
 * Library item shape used when writing progress into Stremio.
 *
 * DEFAULT IS NOW `false` (= a real library item), because this is what makes
 * the automatic path work: Stremio's own native Continue Watching is built
 * from library items, so a title watched in Nuvio only appears there
 * automatically when it is written as a library item. Writing it as a `temp`
 * item stores the position (and our own catalog row can display it) but the
 * native board ignores it - which is exactly why "some movies show up and
 * some don't".
 *
 * Set STREMIO_PROGRESS_TEMP=true to go back to temp items (progress stored,
 * nothing pinned into the library).
 */
const STREMIO_PROGRESS_TEMP_DEFAULT = false;

/**
 * METADATA POLICY: we deliberately do NOT fetch or proxy metadata.
 *
 * The Stremio/Nuvio clients already have the user's own meta addons installed
 * (Cinemeta, TMDB, AIOStreams, ...) and resolve titles/posters themselves.
 * Proxying from here was tried and rejected:
 *
 *   - it added 4-6 extra subrequests -- plus a manifest fetch to every
 *     installed addon host -- to EVERY catalog render, making rows slow;
 *   - it exposed the user's installed-addon list to this Worker;
 *   - it depended on third parties that go down (every Cinemeta mirror was
 *     returning 530), so no fallback could be made reliable anyway.
 *
 * The catalog therefore returns bare references (id + type) and the client's
 * own metadata addons do the resolution -- exactly how they already do it for
 * every other addon. No API keys, and this Worker only ever calls Nuvio's and
 * Stremio's own APIs.
 */

/** Profile used when the install URL does not carry `@<profile>`. */
const DEFAULT_PROFILE_ID = 1;

/** Max rows returned by the Continue Watching catalog. */
const CATALOG_LIMIT = 40;

/**
 * Recent activity ring buffer, used by the /debug self-check page. Per-isolate
 * (a low-traffic Worker effectively has one), best-effort by design - and it
 * ONLY ever records event type, ids, positions and timestamps. Tokens, keys,
 * emails and passwords are never stored anywhere, including here.
 */
const RECENT_LIMIT = 25;
const recentActivity = [];
function noteActivity(kind, detail) {
  recentActivity.unshift({ t: Date.now(), kind, detail });
  if (recentActivity.length > RECENT_LIMIT) recentActivity.pop();
}

// ---------------------------------------------------------------------------
// SMALL HELPERS
// ---------------------------------------------------------------------------

/**
 * CORS is mandatory: "each route, including /manifest.json, must serve
 * CORS headers that allow all origins" - Stremio protocol doc. POST is
 * included because the /login endpoint is consumed by the sign-in page.
 */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/**
 * Security headers for the HTML page.
 *
 * CSP uses a PER-REQUEST NONCE for the inline script instead of
 * 'unsafe-inline', so an injected <script> tag cannot execute even if some
 * future change ever reflected user data into the page. connect-src is
 * 'self' because the page only ever calls this same Worker (sign-in and
 * addon URLs), which also means a compromised CDN cannot exfiltrate anything.
 *
 * frame-ancestors/nosniff/no-referrer close clickjacking, MIME-sniffing and
 * referrer leakage (the addon URL in the page carries tokens).
 *
 * Styles keep 'unsafe-inline': the page is a single file with inline styles,
 * and style injection cannot execute script under this policy.
 */
function securityHeaders(nonce) {
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    `script-src 'nonce-${nonce}' https://cdnjs.cloudflare.com`,
    "connect-src 'self'",
  ].join('; ');
  return {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  };
}

/** Build a JSON response with the mandatory CORS headers. */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/**
 * Response body for event resources. Stremio ignores it, but it must be a
 * valid JSON Response. Event handlers ALWAYS resolve to this - even when the
 * Nuvio push fails - because an error surfacing here could break playback.
 */
const EVENT_OK = { result: 'ok', cacheLimit: 0, staleRecheck: 0, staleErrorTimeout: 0 };

/** 200 JSON response for every event resource. */
const eventOk = () => json(EVENT_OK);

/**
 * Strip the trailing ".json" and split a resource path segment into
 * `key=value` pairs.
 *
 * The player event arrives as, e.g.:
 *     /player/movie/tt0137523/action=pause&currentTime=1830000&duration=7200000.json
 *
 * Note the raw `&` inside the PATH segment - the protocol spec literally
 * documents it that way. We defensively also accept `%26` (encoded) and
 * `%3D` (encoded `=`) because some clients URL-encode the segment.
 */
function parseExtraArgs(extraSegment) {
  const args = {};
  if (!extraSegment) return args;

  const body = extraSegment.replace(/\.json$/i, '');
  // Split on both a literal '&' and its percent-encoded form (%26),
  // since clients differ on how they encode the path segment.
  return body
    .split(/&|%26/i)
    .map((pair) => pair.trim())
    .filter(Boolean)
    .reduce((acc, pair) => {
      // Split "key=value" on the FIRST '=' only ('=' may be url-encoded).
      const eq = pair.indexOf('=');
      if (eq === -1) return acc;
      const key = safeDecode(pair.slice(0, eq)).replace(/%3d/gi, '=').trim();
      const value = safeDecode(pair.slice(eq + 1)).trim();
      if (key) acc[key] = value;
      return acc;
    }, args);
}

/** decodeURIComponent that never throws. */
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** toInt that never returns NaN. */
function toInt(value, fallback = 0) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Origin guard for the sign-in endpoints.
 *
 * Accepts: no Origin header (same-origin POST from our own page - Firefox and
 * several WebViews simply do not send one), our own origin, and the optional
 * configured allowlist entry. Blocks everything else.
 *
 * Note on the threat model: CORS already stops any third-party page from
 * READING a response; this guard only stops casual misuse of the endpoints,
 * so it must never be strict enough to break our own page.
 */
function isAllowedOrigin(request, cfg) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  try {
    if (origin === new URL(request.url).origin) return true;
  } catch {
    return false;
  }
  return !!(cfg.allowedOrigin && origin === cfg.allowedOrigin);
}

/** Read configuration, letting wrangler env bindings win over defaults. */
function getConfig(env) {
  return {
    nuvioBase: (env.NUVIO_BASE || NUVIO_BASE_DEFAULT).replace(/\/+$/, ''),
    nuvioKey: env.NUVIO_PUB_KEY || NUVIO_PUBLISHABLE_KEY_DEFAULT,
    defaultProfileId: toInt(env.PROFILE_ID, DEFAULT_PROFILE_ID) || DEFAULT_PROFILE_ID,
    stremioApi: (env.STREMIO_API || STREMIO_API_DEFAULT).replace(/\/+$/, ''),
    stremioTempItems: (env.STREMIO_PROGRESS_TEMP || String(STREMIO_PROGRESS_TEMP_DEFAULT)) !== 'false',
    // Optional: pin the /login endpoint to your GitHub Pages origin so it
    // cannot be used as a generic Nuvio credential-checking oracle.
    allowedOrigin: (env.ALLOWED_ORIGIN || '').replace(/\/+$/, '') || null,
  };
}

// ---------------------------------------------------------------------------
// NUVIO API CLIENT  (all calls are stateless, token-per-request)
// ---------------------------------------------------------------------------

/**
 * Call a Nuvio sync RPC.
 *
 * Docs (https://nuvio.tv/docs) show every sync RPC taking:
 *   Authorization: Bearer <access_token>
 *   apikey:         <publishable key>
 *
 * `token` here is the user's Nuvio access token, extracted from the
 * request path by the router below. It is used once and never stored.
 */
async function nuvioRpc(cfg, token, fnName, body) {
  const res = await fetch(`${cfg.nuvioBase}/rest/v1/rpc/${fnName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': cfg.nuvioKey,
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  // Nuvio responds 204 on many successful writes; treat 2xx as success and
  // parse JSON only when a body is present.
  const text = await res.text();
  const data = text ? safeJsonParse(text) : null;

  if (!res.ok) {
    const detail = (data && (data.message || data.msg || data.error)) || text.slice(0, 300);
    const err = new Error(`Nuvio ${fnName} failed (${res.status}): ${detail}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Push one progress entry. Nuvio upserts by progress_key, so repeated
 * pause/stop events are naturally idempotent.
 */
async function pushProgress(cfg, token, profileId, entry) {
  return nuvioRpc(cfg, token, 'sync_push_watch_progress', {
    p_profile_id: profileId,
    p_entries: [entry],
  });
}

/**
 * Pull the user's Continue Watching list (latest first).
 * Body: { p_profile_id, p_limit }  (p_since_last_watched omitted -> latest)
 */
async function pullProgress(cfg, token, profileId, limit = CATALOG_LIMIT) {
  const rows = await nuvioRpc(cfg, token, 'sync_pull_watch_progress', {
    p_profile_id: profileId,
    p_limit: limit,
  });
  return Array.isArray(rows) ? rows : [];
}

/**
 * Push a "watched" history item.
 * Body: { p_profile_id, p_items: [{ content_id, content_type, watched_at }] }
 */
async function pushWatched(cfg, token, profileId, item) {
  return nuvioRpc(cfg, token, 'sync_push_watched_items', {
    p_profile_id: profileId,
    p_items: [item],
  });
}

/**
 * Pull the user's watched history (most-recent first, paginated).
 * Body: { p_profile_id, p_limit } - the same data shown on the account
 * dashboard's "Watched" tab (nuvio.tv/accounts?tab=watched).
 */
async function pullWatched(cfg, token, profileId, limit = CATALOG_LIMIT) {
  const rows = await nuvioRpc(cfg, token, 'sync_pull_watched_items', {
    p_profile_id: profileId,
    p_limit: limit,
  });
  return Array.isArray(rows) ? rows : [];
}

/**
 * Nuvio email+password login (Supabase-compatible endpoint).
 *
 * POST {base}/auth/v1/token?grant_type=password
 *   apikey: <publishable key>
 *   { email, password }
 * -> { access_token, refresh_token, expires_in, user }
 *
 * This powers the "Sign in to Nuvio" form on the GitHub Pages site so users
 * never have to hunt for an access token (Nuvio shows it nowhere). The
 * Worker uses the credentials exactly once and returns ONLY the access
 * token to the page - the password is discarded immediately, the refresh
 * token is never forwarded (rotating, single-use, useless in a stateless
 * URL), and nothing is stored or logged.
 */
async function nuvioPasswordLogin(cfg, email, password) {
  const res = await fetch(`${cfg.nuvioBase}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': cfg.nuvioKey,
    },
    body: JSON.stringify({ email, password }),
  });

  const text = await res.text();
  const data = safeJsonParse(text);

  if (!res.ok) {
    let message;
    if (res.status === 400 || res.status === 401) {
      message = 'Invalid email or password';
    } else if (res.status === 429) {
      message = 'Too many attempts - wait a minute and try again';
    } else {
      message = `Nuvio sign-in failed (${res.status})`;
    }
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Map a Supabase-style auth error to a human message. */
function loginErrorMessage(err) {
  return (err && err.message) || 'Sign-in failed';
}

/**
 * POST /stremio-login - links the user's Stremio account.
 *
 * Body: { email, password }
 * Response: { ok, authKey, user }
 *
 * Same privacy contract as /login: the password is exchanged once against
 * api.strem.io/api/login and discarded; only the authKey is returned; nothing
 * is stored or logged. The authKey is embedded in the addon URL so the Worker
 * can write resume points into the user's Stremio library.
 */
async function handleStremioLogin(request, cfg) {
  if (!isAllowedOrigin(request, cfg)) {
    return json({ ok: false, error: 'origin_not_allowed' }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid_body' }, 400);
  }

  const email = String(body.email || '').trim();
  const password = String(body.password || '');
  if (!email || !password) {
    return json({ ok: false, error: 'email_and_password_required' }, 400);
  }

  let authKey;
  let user = null;
  try {
    authKey = await stremioLogin(cfg, email, password);
    // Confirm the key works before handing it back.
    user = await stremioGetUser(cfg, authKey);
  } catch (err) {
    const bad = err.status === 400 || err.status === 401;
    return json({
      ok: false,
      error: bad ? 'Invalid Stremio email or password' : (err.message || 'Stremio sign-in failed'),
    }, bad ? 400 : 502);
  }

  return json({
    ok: true,
    authKey,
    user: user && user._id ? { id: user._id, email: user.email } : null,
  });
}

/**
 * POST /login - the GitHub Pages sign-in form's endpoint.
 *
 * Body: { email, password }
 * Response: { ok, access_token, expires_in, profiles }
 *
 * The access_token is what the page embeds in the generated addon URL;
 * profiles are returned so the UI can show real profile names.
 */
async function handleLogin(request, cfg) {
  if (!isAllowedOrigin(request, cfg)) {
    return json({ ok: false, error: 'origin_not_allowed' }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid_body' }, 400);
  }

  const email = String(body.email || '').trim();
  const password = String(body.password || '');
  if (!email || !password) {
    return json({ ok: false, error: 'email_and_password_required' }, 400);
  }

  let session;
  try {
    session = await nuvioPasswordLogin(cfg, email, password);
  } catch (err) {
    return json({ ok: false, error: loginErrorMessage(err) }, err.status || 502);
  }

  const accessToken = session && session.access_token;
  if (!accessToken) {
    return json({ ok: false, error: 'no_token_in_response' }, 502);
  }

  // Pull profile names with the brand-new token so the UI can label the
  // profile picker ("Main #1, Kids #2"). A failure here is not fatal - the
  // user can still pick a number.
  let profiles = [];
  try {
    const rows = await nuvioRpc(cfg, accessToken, 'sync_pull_profiles', {});
    if (Array.isArray(rows)) {
      profiles = rows.map((p) => ({ name: p.name, index: p.profile_index }));
    }
  } catch {
    /* profile listing is best-effort */
  }

  // NOTE: only the access token is returned. No refresh token, no password,
  // no user payload, and nothing is written to any store.
  return json({
    ok: true,
    access_token: accessToken,
    expires_in: session.expires_in || 3600,
    profiles,
  });
}

// ---------------------------------------------------------------------------
// ID PARSING (Stremio ids -> Nuvio entries)
// ---------------------------------------------------------------------------

/**
 * Stremio videoID shapes:
 *   movie:  tt0137523
 *   series: tt0903747:1:1        (content:season:episode)
 *
 * Nuvio entry shape:
 *   movie:  { content_id: "tt0137523", content_type: "movie",
 *             video_id: "tt0137523" }
 *   series: { content_id: "tt0903747", content_type: "series",
 *             video_id: "tt0903747:1:1", season: 1, episode: 1 }
 *
 * Nuvio derives its own progress_key ({content_id} for movies,
 * {content_id}_s{season}e{episode} for episodes) server-side.
 */
function buildProgressEntry(type, videoId, currentTimeMs, durationMs) {
  const now = Date.now();
  const base = {
    content_type: type === 'series' ? 'series' : 'movie',
    content_id: videoId,
    video_id: videoId,
    position: currentTimeMs,
    duration: durationMs,
    last_watched: now,
  };

  if (type === 'series') {
    const parts = videoId.split(':');
    base.content_id = parts[0] || videoId;
    const season = toInt(parts[1], NaN);
    const episode = toInt(parts[2], NaN);
    if (Number.isFinite(season)) base.season = season;
    if (Number.isFinite(episode)) base.episode = episode;
  }
  return base;
}


// ---------------------------------------------------------------------------
// STREMIO ACCOUNT API (library write-back - makes Nuvio progress resumable
// inside Stremio, which the addon protocol alone cannot do)
// ---------------------------------------------------------------------------

/**
 * Call a Stremio account API method. Envelope: { result, error } where
 * result is null on some successes. Errors carry { code, message }.
 */
async function stremioApi(cfg, method, body) {
  const res = await fetch(`${cfg.stremioApi}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'stremio-nuvio-sync/1.0' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const data = safeJsonParse(text);

  if (!res.ok) {
    const msg = (data && data.error && (data.error.message || data.error.msg))
      || (data && data.message) || text.slice(0, 200);
    const err = new Error(`Stremio ${method} failed (${res.status}): ${msg}`);
    err.status = res.status;
    throw err;
  }
  if (data && data.error && Object.keys(data.error).length) {
    const msg = data.error.message || data.error.msg || 'unknown error';
    const err = new Error(`Stremio ${method}: ${msg}`);
    err.status = 400;
    throw err;
  }
  return data ? data.result : null;
}

/**
 * Stremio login: POST /api/login
 *   { type:"Auth", type:"Login", email, password, facebook:false }
 *   -> { result: { authKey, user } }
 *
 * Powers the "Link Stremio account" step on the page. The authKey is returned
 * to the browser (memory only) and embedded in the addon URL; the password is
 * discarded immediately and nothing is stored.
 */
async function stremioLogin(cfg, email, password) {
  const result = await stremioApi(cfg, 'login', {
    type: 'Auth',
    type: 'Login',
    email,
    password,
    facebook: false,
  });
  const authKey = result && (result.authKey || result.key);
  if (!authKey) {
    const err = new Error('Stremio login did not return an authKey');
    err.status = 502;
    throw err;
  }
  return authKey;
}

/** Validate an authKey by fetching the user (also used by /stremio-login). */
async function stremioGetUser(cfg, authKey) {
  return stremioApi(cfg, 'getUser', { type: 'GetUser', authKey });
}

/**
 * Read library items: POST /api/datastoreGet { authKey, collection, ids, all }.
 *
 * `all: true` only when NO ids are requested - note an empty array is truthy
 * in JS, so the length check matters (passing [] must mean "the whole
 * library", not "nothing").
 */
async function stremioDatastoreGet(cfg, authKey, ids) {
  const hasIds = Array.isArray(ids) && ids.length > 0;
  return stremioApi(cfg, 'datastoreGet', {
    authKey,
    collection: 'libraryItem',
    ids: hasIds ? ids : [],
    all: !hasIds,
  });
}

/** Write library items: POST /api/datastorePut { authKey, collection, changes }. */
async function stremioDatastorePut(cfg, authKey, changes) {
  return stremioApi(cfg, 'datastorePut', {
    authKey,
    collection: 'libraryItem',
    changes,
  });
}

/** ISO timestamp for Stremio's *_ctime/_mtime/lastWatched fields. */
function isoNow(offsetMs) {
  return new Date(Date.now() + (offsetMs || 0)).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Build a Stremio library item carrying a resume position.
 *
 * The important part is `state`:
 *   timeOffset  - current playback position in MS (what the player resumes from)
 *   duration    - total runtime in MS
 *   video_id    - the exact video for series ("tt1:2:3"); the movie id for movies
 *   lastWatched - when it was last watched (used by Stremio for ordering)
 *
 * temp/removed: temp items hold progress without pinning the title into the
 * user's library; flip STREMIO_PROGRESS_TEMP=false for library-pinned items.
 */
function buildStremioLibraryItem(row, cfg) {
  const type = row.content_type === 'series' ? 'series' : 'movie';
  const position = toInt(row.position, 0);
  const duration = toInt(row.duration, 0);
  const videoId = row.video_id || row.content_id;
  const name = row.content_id; // the client resolves the real title itself
  const poster = null;
  // lastWatched carries the SOURCE timestamp (Nuvio's last_watched), not "now".
  // This is what makes the bridge idempotent: after Nuvio -> Stremio, both
  // sides hold the same logical timestamp, so the reverse pass can never
  // mistake our own write for a newer Stremio position and bounce it back
  // (which would ping-pong forever, bumping timestamps each cycle).
  // _mtime stays "now" - Stremio's own sync uses it to notice the change.
  const sourceLastWatched = row.last_watched
    ? new Date(row.last_watched).toISOString()
    : isoNow();
  const now = isoNow();

  return {
    _id: row.content_id,
    name,
    type,
    poster: poster || null,
    posterShape: 'poster',
    removed: false,
    temp: cfg.stremioTempItems,
    _ctime: now,
    _mtime: now,
    state: {
      lastWatched: sourceLastWatched,
      timeWatched: position,
      timeOffset: position,
      overallTimeWatched: position,
      timesWatched: 1,
      flaggedWatched: 0,
      duration,
      video_id: type === 'series' ? videoId : videoId,
      watched: null,
      noNotif: false,
    },
    behaviorHints: {
      defaultVideoId: type === 'series' ? videoId : null,
      featuredVideoId: null,
      hasScheduledVideos: false,
    },
  };
}

/**
 * Merge our progress item into the item Stremio already has, if any.
 *
 * Why merge instead of overwrite: the user's Stremio account may already hold
 * the real metadata for this title (name, poster, behaviorHints) resolved by
 * the client's own meta addons, plus a `watched` bitfield marking episodes
 * seen. Blindly overwriting would (a) replace real titles with our bare tt id
 * and (b) destroy the watched bitfield. So existing data wins for everything
 * except the playback state we are explicitly here to update.
 *
 * Also: an existing `temp` item is promoted to a library item and a `removed`
 * item is re-added - both mirror what Stremio itself does when you play
 * something (playing a title puts it back in your library).
 */
function mergeStremioItem(item, existing) {
  if (!existing) return item;

  const state = { ...(existing.state || {}), ...item.state };
  // Never clobber the watched bitfield (episode-level watched state).
  if (existing.state && existing.state.watched != null) {
    state.watched = existing.state.watched;
  }

  return {
    ...item,            // our defaults
    ...existing,        // existing metadata wins (real name/poster/etc.)
    _ctime: existing._ctime || item._ctime,
    _mtime: item._mtime,
    temp: item.temp,    // config-driven (default: a real library item)
    removed: false,     // playing re-adds it, like Stremio does
    state,
  };
}

/**
 * Is this Nuvio progress row newer than what Stremio already has?
 * Prevents redundant writes (each datastorePut is a request against the
 * free-tier budget, and pointless writes would churn the user's account).
 */
function isNewerThanStremio(row, existing) {
  if (!existing || !existing.state) return true;
  const stremioOffset = toInt(existing.state.timeOffset, 0);
  const stremioLast = existing.state.lastWatched ? (Date.parse(existing.state.lastWatched) || 0) : 0;
  const nuvioLast = toInt(row.last_watched, 0);
  const nuvioPos = toInt(row.position, 0);

  // Identical position, and Stremio is at least as recent -> already synced.
  if (nuvioPos === stremioOffset && (!nuvioLast || stremioLast <= nuvioLast)) return false;
  // Nuvio has no usable timestamp: trust the source when the position differs.
  if (!nuvioLast) return nuvioPos !== stremioOffset;
  return nuvioLast > stremioLast;
}

/**
 * Push a batch of Nuvio progress rows into the user's Stremio account so
 * Stremio's own Continue Watching resumes at the right place.
 *
 * Writes at most STREMIO_WRITE_BATCH items per call; without storage there
 * is no durable queue, so the remainder are simply picked up on the next
 * catalog request (they are still newer than Stremio's copy).
 *
 * `metaMap` is optional (id -> { name, poster }): the catalog path passes the
 * library-join map, the real-time player-event path passes nothing and the
 * merge with any existing Stremio item still supplies the real title.
 */
const STREMIO_WRITE_BATCH = 10;

async function syncProgressToStremio(cfg, stremioKey, rows, metaMap) {
  if (!stremioKey || !Array.isArray(rows) || !rows.length) return { written: 0 };

  // Only rows that actually carry a resumable position.
  const candidates = rows
    .filter((r) => r.content_id && toInt(r.position, 0) > 0 && toInt(r.duration, 0) > 0)
    .slice(0, STREMIO_WRITE_BATCH);
  if (!candidates.length) return { written: 0 };

  let written = 0;
  try {
    const existing = await stremioDatastoreGet(cfg, stremioKey, candidates.map((r) => r.content_id));
    const byId = new Map();
    if (Array.isArray(existing)) {
      for (const item of existing) if (item && item._id) byId.set(item._id, item);
    } else if (existing && typeof existing === 'object') {
      // Some responses are keyed by id.
      for (const [id, item] of Object.entries(existing)) if (item && item._id) byId.set(item._id, item);
    }

    for (const row of candidates) {
      const existing = byId.get(row.content_id);
      if (!isNewerThanStremio(row, existing)) continue;
      try {
        const item = buildStremioLibraryItem(row, cfg);
        const meta = metaMap && metaMap.get(row.content_id);
        if (meta && meta.name) item.name = meta.name;
        if (meta && meta.poster) item.poster = meta.poster;
        const merged = mergeStremioItem(item, existing);
        await stremioDatastorePut(cfg, stremioKey, [merged]);
        written += 1;
        noteActivity('write-stremio', `${row.content_id} @ ${toInt(row.position, 0)}ms`);
        console.log(
          `[stremio] wrote resume point for ${row.content_id} @ ${toInt(row.position, 0)}ms ` +
          `(${existing ? 'merged into existing ' + (existing.temp ? 'temp' : 'library') + ' item' : 'new library item'})`
        );
      } catch (err) {
        console.error(`[stremio] write failed for ${row.content_id}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`[stremio] datastoreGet failed: ${err.message}`);
  }
  return { written };
}

/**
 * Write ONE progress row into Stremio (used by the real-time player-event
 * path when Nuvio reports playback).
 */
async function pushProgressToStremio(cfg, stremioKey, row) {
  return syncProgressToStremio(cfg, stremioKey, [row]);
}

// ---------------------------------------------------------------------------
// EVENT HANDLERS (the actual gap-fillers)
// ---------------------------------------------------------------------------

/**
 * Handle a `player` event: parse action/currentTime/duration out of the path
 * and fire the position at Nuvio's sync API.
 *
 * IMPORTANT: this handler must NEVER surface an error to the player - a
 * failure here would break the user's playback. Everything is caught and
 * logged; the response is always 200 JSON.
 */
async function handlePlayerEvent(type, videoId, extraSegment, cfg, token, profileId, stremioKey, ctx) {
  // ---- 1. Parse the protocol's query-style parameters out of the path ----
  const args = parseExtraArgs(extraSegment);
  const action = (args.action || '').toLowerCase();
  const currentTime = toInt(args.currentTime, 0); // ms into the video
  const duration = toInt(args.duration, 0);       // total runtime in ms

  // Actions per protocol: start (also re-sent on seek), pause, stop
  // (player closed / video changed / ended). Older drafts used
  // play/end - accept them so we are not client-version dependent.
  const known = new Set(['start', 'play', 'pause', 'stop', 'end']);
  console.log(
    `[player] ${action} ${type}:${videoId} @ ${currentTime}/${duration}ms ` +
    `(profile ${profileId})`
  );
  noteActivity('player', `${action} ${type}:${videoId} @ ${currentTime}/${duration}ms`);

  if (!known.has(action)) return eventOk();

  // ---- 2. Validate before spending an upstream call ----
  // Without a duration Nuvio cannot place the resume point, and the schema
  // requires it. Without a position (playback barely started / was at 0)
  // there is nothing worth syncing - a 0% Continue Watching row is just noise,
  // so we skip the write regardless of the action.
  if (duration <= 0) {
    console.log('[player] skip push: missing duration');
    return eventOk();
  }
  if (currentTime <= 0) {
    console.log('[player] skip push: playback at position 0 (nothing to sync yet)');
    return eventOk();
  }

  // ---- 3. Build the Nuvio entry from Stremio ids ----
  const entry = buildProgressEntry(type, videoId, currentTime, duration);

  // ---- 4a. Fire it at Nuvio immediately ----
  try {
    await pushProgress(cfg, token, profileId, entry);
    const pct = Math.round((currentTime / duration) * 100);
    console.log(`[player] pushed ${entry.content_id} at ${pct}% to Nuvio profile ${profileId}`);
    noteActivity('push-nuvio', `${entry.content_id} at ${pct}% (profile ${profileId})`);
  } catch (err) {
    // Never break playback because of a sync failure.
    console.error(`[player] push failed: ${err.message}`);
  }

  // ---- 4b. Mirror it into the user's Stremio account, if linked ----
  // This is the direction the addon protocol cannot do on its own: Stremio's
  // own Continue Watching reads `libraryItem.state.timeOffset`, writable only
  // through the Stremio account API. Without a linked Stremio key this is a
  // no-op and the Nuvio -> Stremio direction is display-only.
  if (stremioKey) {
    // Background: the player ignores our response anyway, so there is no
    // reason to make the event wait on Stremio's API.
    const job = pushProgressToStremio(cfg, stremioKey, entry)
      .catch((err) => console.error(`[player] stremio write-back failed: ${err.message}`));
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
    else await job;
  }

  // Note: Nuvio auto-upserts a watched-history entry when
  // duration >= 60000 && position >= 90% duration, so we do NOT need a
  // separate "watched" write on `stop` - finish detection is handled there.
  return eventOk();
}

/**
 * Handle a `library` event. We only forward the watched toggles:
 *   action=watched[&videoId=tt1,tt2]      -> Nuvio watched history
 *   action=unwatched                     -> (library history left as-is)
 *   action=libraryAdd/libraryRemove      -> (full-replace endpoint; skipped)
 */
async function handleLibraryEvent(type, id, extraSegment, cfg, token, profileId) {
  const args = parseExtraArgs(extraSegment);
  const action = (args.action || '').toLowerCase();

  if (action !== 'watched') {
    console.log(`[library] ignoring action=${action} for ${type}:${id}`);
    return eventOk();
  }

  // `videoId` may list specific videos for a season mark; otherwise the
  // requested id itself is the item.
  const ids = (args.videoId || id)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

  for (const videoId of ids) {
    try {
      // For episodes ("tt1:2:3") Nuvio watched history keys on content_id.
      const contentId = type === 'series' ? (videoId.split(':')[0] || videoId) : videoId;
      await pushWatched(cfg, token, profileId, {
        content_id: contentId,
        content_type: type === 'series' ? 'series' : 'movie',
        watched_at: Date.now(),
      });
      console.log(`[library] marked watched: ${contentId}`);
    } catch (err) {
      console.error(`[library] watched push failed for ${videoId}: ${err.message}`);
    }
  }
  return eventOk();
}

/**
 * Handle `stream` requests.
 *
 * We are not a stream provider - the user's Torrentio/AIOStreams/etc
 * addons serve the actual media. This route exists only as a heartbeat
 * signal ("playback was attempted for this id") and returns an empty
 * stream list. We deliberately do NOT write a fake position here: a
 * position-0 write would clobber a real resume point in Nuvio.
 */
function handleStreamRequest(type, id) {
  console.log(`[stream] playback attempted for ${type}:${id} (no position known - not pushing)`);
  return json({ streams: [] });
}

// ---------------------------------------------------------------------------
// CATALOG (Nuvio -> Stremio: "Continue Watching" row)
// ---------------------------------------------------------------------------

/**
 * Turn the user's Nuvio data into Stremio catalog responses.
 *
 * Two rows are declared in the manifest:
 *   - "Continue Watching (Nuvio)"  <- watch progress  (partial positions)
 *   - "Watched (Nuvio)"            <- watch history   (completed items,
 *                                     the account dashboard's Watched tab)
 *
 * This is the same mechanism the Letterboxd addons use (fetch external
 * account data, render it as a Stremio row) - except the source is the
 * user's own Nuvio account.
 */
async function handleCatalog(type, catalogId, cfg, token, profileId, stremioKey, ctx) {
  // Ignore catalogs we do not declare.
  if (catalogId !== 'nuviocw' && catalogId !== 'nuviowatched') return json({ metas: [] });

  const wantedType = type === 'series' ? 'series' : 'movie';

  // Titles/posters for the row, from the user's own libraries (cached).
  const metaMap = await pullLibraryMeta(cfg, token, profileId, stremioKey).catch(() => new Map());

  let rows = [];
  try {
    rows = catalogId === 'nuviocw'
      ? await pullProgress(cfg, token, profileId, CATALOG_LIMIT)
      : await pullWatched(cfg, token, profileId, CATALOG_LIMIT);
  } catch (err) {
    console.error(`[catalog] pull failed: ${err.message}`);
    return json({ metas: [] }); // degrade to empty rather than erroring the UI
  }

  const metas = [];

  for (const row of rows) {
    if (row.content_type && row.content_type !== wantedType) continue;
    if (!row.content_id) continue;

    // Titles/posters come from the user's OWN libraries (Nuvio + Stremio),
    // never from a third-party metadata service. Where we have nothing, the
    // raw id is shown and the client may still resolve it itself.
    const meta = metaMap && metaMap.get(row.content_id);
    const base = {
      id: row.content_id,
      type: wantedType,
      name: (meta && meta.name) || row.content_id,
      poster: (meta && meta.poster) || undefined,
      posterShape: 'poster',
    };

    if (catalogId === 'nuviocw') {
      // Progress row: surface the resume point as a percentage.
      const position = toInt(row.position, 0);
      const duration = toInt(row.duration, 0);
      const pct = duration > 0 ? Math.min(100, Math.round((position / duration) * 100)) : null;
      base.description = pct !== null ? `Nuvio: ${pct}% watched` : 'Nuvio: in progress';
    } else {
      // Watched row: show when it was completed, if Nuvio recorded it.
      const at = toInt(row.watched_at, 0);
      base.description = at > 0
        ? `Watched on ${new Date(at).toISOString().slice(0, 10)}`
        : 'Watched';
    }

    metas.push(base);
  }

  // Nuvio -> Stremio resume: mirror the freshly pulled progress into the
  // user's Stremio account (if linked) so Stremio's own Continue Watching
  // resumes at the right position.
  //
  // Runs in the BACKGROUND (ctx.waitUntil) so the catalog returns instantly:
  // previously this blocked the response, which is what made the row feel
  // slow. Best-effort: failures never fail the row.
  if (stremioKey && catalogId === 'nuviocw' && rows.length) {
    const job = syncProgressToStremio(cfg, stremioKey, rows, metaMap)
      .catch((err) => console.error(`[catalog] stremio write-back failed: ${err.message}`));
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
    else await job;
  }

  return json({ metas: metas.slice(0, CATALOG_LIMIT) });
}

// ---------------------------------------------------------------------------
// TITLES & POSTERS - sourced from the user's OWN data (keyless)
// ---------------------------------------------------------------------------

/**
 * The catalog rows are references; a title and poster make them usable. We do
 * NOT call any third-party metadata provider (Cinemeta is down globally, and
 * keys are a non-starter). Instead we join our progress rows against data the
 * user already owns:
 *
 *   1. their Nuvio library      (sync_pull_library)   - works for everyone
 *   2. their Stremio library    (datastoreGet all)    - when Stremio is linked
 *
 * Both are ONE cached call each (per isolate, 10 min TTL), so the join costs
 * one extra request on a cold isolate and nothing afterwards. Stremio's copy
 * wins where both have the title, because it carries metadata the user's own
 * client already resolved.
 */
const libraryMetaCache = new Map(); // key -> { expires, value: Map }
const LIBRARY_META_TTL_MS = 10 * 60 * 1000;

/** Harvest id -> { name, poster } from an arbitrary array of library-ish rows. */
function harvestLibraryMeta(rows, map) {
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = row.content_id || row._id || row.id;
    if (typeof id !== 'string' || !/^tt\d/.test(id)) continue;
    const name = row.name || row.title || null;
    const poster = row.poster || row.poster_url
      || (row.poster_path ? `https://image.tmdb.org/t/p/w300${row.poster_path}` : null)
      || null;
    if (name || poster) map.set(id, { name, poster });
  }
}

/** id -> { name, poster } built from Nuvio (+ Stremio) libraries. */
async function pullLibraryMeta(cfg, token, profileId, stremioKey) {
  const key = `libmeta:${profileId}:${stremioKey ? 's' : 'n'}:${token ? 't' : '-'}`;
  const hit = libraryMetaCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  const map = new Map();

  // 1a. Nuvio library (the user's own adds - carries names and posters).
  if (token) {
    try {
      const rows = await nuvioRpc(cfg, token, 'sync_pull_library', {
        p_profile_id: profileId,
        p_limit: 500,
      });
      harvestLibraryMeta(rows, map);
    } catch {
      /* library is optional */
    }

    // 1b. Nuvio watch history - rows here carry titles even when the title was
    // never added to the library, which is the most common case for things
    // watched only inside Nuvio.
    try {
      const rows = await nuvioRpc(cfg, token, 'sync_pull_watched_items', {
        p_profile_id: profileId,
        p_limit: 500,
      });
      harvestLibraryMeta(rows, map);
    } catch {
      /* history is optional */
    }
  }

  // 2. Stremio library (client-resolved metadata, so it wins on conflict).
  if (stremioKey) {
    try {
      const res = await fetch(`${cfg.stremioApi}/datastoreGet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'stremio-nuvio-sync/1.0' },
        body: JSON.stringify({ authKey: stremioKey, collection: 'libraryItem', ids: [], all: true }),
      });
      if (res.ok) {
        const data = await res.json();
        const items = data && data.result ? data.result : [];
        for (const item of items) {
          if (!item || typeof item._id !== 'string' || !/^tt\d/.test(item._id)) continue;
          if (item.name || item.poster) map.set(item._id, { name: item.name, poster: item.poster });
        }
      }
    } catch {
      /* library is optional */
    }
  }

  libraryMetaCache.set(key, { expires: Date.now() + LIBRARY_META_TTL_MS, value: map });
  console.log(`[meta] library join built: ${map.size} titled ids`);
  return map;
}

// ---------------------------------------------------------------------------
// AUTOMATIC SYNC (triggered by the manifest request)
// ---------------------------------------------------------------------------

/**
 * Read the user's Stremio positions as Nuvio-shaped progress rows.
 *
 * Stremio's own library stores the live playback position of everything
 * watched in Stremio (`state.timeOffset` / `state.duration` / `state.lastWatched`),
 * so this is the Stremio -> Nuvio source. It works whether or not the client
 * emits player events - which is the whole point: it removes the dependency
 * on the client volunteering its position.
 */
async function pullStremioProgress(cfg, stremioKey) {
  const items = await stremioDatastoreGet(cfg, stremioKey, []);
  const rows = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it._id !== 'string' || !/^tt\d/.test(it._id)) continue;
    const st = it.state || {};
    const position = toInt(st.timeOffset, 0);
    const duration = toInt(st.duration, 0);
    if (position <= 0 || duration <= 0) continue; // nothing resumable
    const type = it.type === 'series' ? 'series' : 'movie';
    const videoId = type === 'series' ? (st.video_id || it._id) : it._id;
    rows.push({
      content_id: it._id,
      content_type: type,
      video_id: videoId,
      position,
      duration,
      last_watched: st.lastWatched ? (Date.parse(st.lastWatched) || 0) : 0,
    });
  }
  return rows;
}

/** Stremio row newer than Nuvio's copy? (mirror of isNewerThanStremio) */
function isNewerThanNuvio(stremioRow, nuvioRow) {
  if (!nuvioRow) return true;
  const nuvioPos = toInt(nuvioRow.position, 0);
  const nuvioLast = toInt(nuvioRow.last_watched, 0);
  const stremioLast = stremioRow.last_watched || 0;
  const stremioPos = toInt(stremioRow.position, 0);

  // Identical position, and Nuvio at least as recent -> already synced.
  if (nuvioPos === stremioPos && (!stremioLast || nuvioLast <= stremioLast)) return false;
  // Stremio has no usable timestamp: trust the source when the position differs.
  if (!stremioLast) return nuvioPos !== stremioPos;
  return stremioLast > nuvioLast;
}

/**
 * Push the user's Stremio positions into Nuvio. `nuvioRows` is the current
 * Nuvio state (already fetched by the caller) used for conflict resolution.
 */
async function syncStremioToNuvio(cfg, token, profileId, stremioRows, nuvioRows) {
  if (!Array.isArray(stremioRows) || !stremioRows.length) return { written: 0 };

  const byId = new Map();
  for (const r of nuvioRows || []) if (r && r.content_id) byId.set(r.content_id, r);

  let written = 0;
  for (const row of stremioRows.slice(0, STREMIO_WRITE_BATCH)) {
    if (!isNewerThanNuvio(row, byId.get(row.content_id))) continue;
    try {
      const entry = buildProgressEntry(row.content_type, row.video_id, row.position, row.duration);
      entry.last_watched = row.last_watched || Date.now();
      await pushProgress(cfg, token, profileId, entry);
      written += 1;
      const pct = Math.round((row.position / Math.max(row.duration, 1)) * 100);
      noteActivity('push-nuvio', `${entry.content_id} at ${pct}% (from Stremio)`);
      console.log(`[stremio->nuvio] pushed ${entry.content_id} at ${pct}%`);
    } catch (err) {
      console.error(`[stremio->nuvio] push failed for ${row.content_id}: ${err.message}`);
    }
  }
  return { written };
}

/**
 * Pull the user's Nuvio progress and write it into their Stremio account.
 *
 * Called when either app requests the manifest - i.e. on app open and on the
 * clients' periodic addon refresh - so Nuvio -> Stremio resume happens without
 * the user having to open any particular row.
 *
 * Bounded and defensive: the manifest is latency-sensitive, so this is capped
 * at one progress pull + STREMIO_WRITE_BATCH writes, and every failure is
 * swallowed (a sync problem must never break addon installation).
 */
async function autoSyncFromManifest(cfg, token, profileId, stremioKey) {
  try {
    const metaMap = await pullLibraryMeta(cfg, token, profileId, stremioKey);

    // Current state of both sides.
    let nuvioRows = [];
    try {
      nuvioRows = await pullProgress(cfg, token, profileId, CATALOG_LIMIT);
    } catch (err) {
      console.error(`[auto-sync] Nuvio pull failed: ${err.message}`);
      return;
    }

    // Direction 1: Nuvio -> Stremio (resume points for the Nuvio side).
    const { written } = await syncProgressToStremio(cfg, stremioKey, nuvioRows, metaMap);

    // Direction 2: Stremio -> Nuvio (positions from the Stremio account).
    // Read from the account, NOT from player events: this works even when the
    // client never emits them, which is what made this direction dead.
    let pushed = 0;
    try {
      const stremioRows = await pullStremioProgress(cfg, stremioKey);
      pushed = (await syncStremioToNuvio(cfg, token, profileId, stremioRows, nuvioRows)).written;
    } catch (err) {
      console.error(`[auto-sync] Stremio pull failed: ${err.message}`);
    }

    console.log(`[auto-sync] manifest-triggered sync: ${written} written to Stremio, ${pushed} pushed to Nuvio`);
    noteActivity('auto-sync', `${written} to Stremio + ${pushed} to Nuvio`);
  } catch (err) {
    console.error(`[auto-sync] failed: ${err.message}`);
  }
}

/**
 * Self-check page: /t/<token>@<profile>/s/<stremioKey>/debug
 *
 * Runs the whole chain live and reports it as a readable page, so nobody has
 * to install wrangler or read logs to know whether their sync works:
 *
 *   1. is the Nuvio token valid, and which profiles exist
 *   2. is the Stremio account linked and valid (the /s/ segment)
 *   3. how many Continue Watching items Nuvio has, and the most recent one
 *   4. how many items the Stremio account library holds
 *   5. how many resume points this sync WOULD write right now
 *   6. the recent event activity this Worker instance has seen
 *
 * Read-only except for nothing - it writes nothing anywhere.
 */
async function handleDebug(cfg, token, profileId, stremioKey) {
  const checks = [];
  const ok = (label, value, good) => checks.push({ label, value, good });

  // 1. Nuvio token
  let profiles = [];
  try {
    const rows = await nuvioRpc(cfg, token, 'sync_pull_profiles', {});
    profiles = Array.isArray(rows) ? rows : [];
    ok('Nuvio token', `valid - ${profiles.length} profile(s): ` +
      profiles.map((p) => `${p.name || 'profile'} #${p.profile_index}`).join(', '), true);
  } catch (err) {
    ok('Nuvio token', `INVALID - ${err.message}`, false);
  }

  // 2. Stremio link
  if (stremioKey) {
    try {
      const user = await stremioGetUser(cfg, stremioKey);
      ok('Stremio account', `linked and valid (user ${user && user._id ? user._id : 'unknown'})`, true);
    } catch (err) {
      ok('Stremio account', `link present but REJECTED - ${err.message}`, false);
    }
  } else {
    ok('Stremio account', 'NOT LINKED - Nuvio progress cannot resume inside Stremio. ' +
      'Use "Link Stremio" on the start page and reinstall the generated URL.', false);
  }

  // 3. Nuvio progress
  let rows = [];
  try {
    rows = await pullProgress(cfg, token, profileId, CATALOG_LIMIT);
    const newest = rows[0];
    ok('Nuvio Continue Watching', `${rows.length} item(s)` +
      (newest ? ` - most recent: ${newest.content_id} at ${Math.round((newest.position / Math.max(newest.duration, 1)) * 100)}%` : ''), rows.length > 0);
  } catch (err) {
    ok('Nuvio Continue Watching', `could not read - ${err.message}`, false);
  }

  // 4. Stremio library size
  if (stremioKey) {
    try {
      const items = await stremioDatastoreGet(cfg, stremioKey, []);
      const arr = Array.isArray(items) ? items : [];
      ok('Stremio library', `${arr.length} item(s) in the account`, true);
    } catch (err) {
      ok('Stremio library', `could not read - ${err.message}`, false);
    }
  }

  // 5. What a sync would write right now (simulated, nothing written)
  if (stremioKey && rows.length) {
    try {
      const existing = await stremioDatastoreGet(cfg, stremioKey, rows.filter((r) => r.content_id).map((r) => r.content_id));
      const byId = new Map();
      if (Array.isArray(existing)) for (const it of existing) if (it && it._id) byId.set(it._id, it);
      const wouldWrite = rows.filter((r) => r.content_id && isNewerThanStremio(r, byId.get(r.content_id))).length;
      ok('Pending sync', wouldWrite > 0
        ? `${wouldWrite} resume point(s) are newer than Stremio's copy - these will be written on the next manifest fetch (open either app) or catalog visit`
        : 'everything in Nuvio is already mirrored into Stremio', true);
    } catch (err) {
      ok('Pending sync', `could not compare - ${err.message}`, false);
    }
  }

  // 6. Recent activity seen by this Worker instance
  const activity = recentActivity.slice(0, 12).map((e) => ({
    t: new Date(e.t).toISOString().replace('T', ' ').slice(0, 19),
    kind: e.kind,
    detail: e.detail,
  }));

  return htmlResponse(debugReportHtml(checks, activity, profileId));
}

/** HTML response with tight headers (no scripts needed on this page). */
function htmlResponse(body) {
  return new Response(body, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      ...CORS_HEADERS,
    },
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function debugReportHtml(checks, activity, profileId) {
  const rows = checks.map((c) => `
    <tr>
      <td class="k">${esc(c.label)}</td>
      <td class="${c.good ? 'ok' : 'bad'}">${esc(c.value)}</td>
    </tr>`).join('');

  const acts = activity.length
    ? activity.map((a) => `<tr><td class="tt">${esc(a.t)}</td><td class="k">${esc(a.kind)}</td><td>${esc(a.detail)}</td></tr>`).join('')
    : `<tr><td colspan="3" class="dim">no events seen by this Worker instance yet - play something in either app, then reload this page</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sync self-check</title>
<style>
  body{background:#0a0a0f;color:#e8e8f0;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;padding:28px}
  .c{max-width:760px;margin:0 auto}
  h1{font-size:20px;margin:0 0 4px}
  .sub{color:#9a9ab0;margin:0 0 22px}
  h2{font-size:14px;color:#9a9ab0;text-transform:uppercase;letter-spacing:.06em;margin:26px 0 8px}
  table{width:100%;border-collapse:collapse;background:#12121a;border:1px solid #262636;border-radius:10px;overflow:hidden}
  td{padding:9px 12px;border-bottom:1px solid #262636;vertical-align:top}
  tr:last-child td{border-bottom:none}
  td.k{color:#9a9ab0;width:34%}
  .ok{color:#34d399}.bad{color:#f87171}
  .tt{color:#6b6b85;font-family:ui-monospace,monospace;white-space:nowrap}
  .dim{color:#6b6b85}
  .foot{margin-top:22px;color:#6b6b85;font-size:12.5px}
</style></head><body><div class="c">
<h1>Sync self-check</h1>
<p class="sub">Profile #${esc(profileId)} &middot; read-only &middot; nothing here is stored anywhere</p>
<h2>Connection</h2><table>${rows}</table>
<h2>Recent events (this Worker instance)</h2><table>${acts}</table>
<p class="foot">Events are held in memory by the Worker instance that served them and are never persisted.
If <em>player</em> events never appear here, that app is not emitting playback events - the sync then relies on
the automatic manifest fetch (opening either app) and the Continue Watching row.</p>
</div></body></html>`;
}

// ---------------------------------------------------------------------------
// ROUTER
// ---------------------------------------------------------------------------

/**
 * Accepted URL shapes (Stremio installs the manifest and derives every later
 * request from its directory):
 *
 *   /manifest.json?nuvioToken=X                     simple, query form
 *   /t/<token>@<profile>/manifest.json              preferred, path form
 *   /t/<token>@<profile>/player/movie/tt123/action=pause&currentTime=..&duration=...json
 *   /t/<token>@<profile>/catalog/movie/nuviocw.json
 *   /t/<token>@<profile>/stream/movie/tt123.json
 *   /t/<token>@<profile>/library/movie/tt123/action=watched.json
 *   /t/<token>@<profile>/health                     token validation probe
 */
function parseTokenSegment(segment) {
  // "TOKEN@PROFILE" - profile is optional (e.g. "abc123@2" or "abc123").
  // Split on the LAST '@': tokens are opaque and may themselves contain '@'
  // (JWT-adjacent tokens often do), while the profile suffix never does.
  const at = segment.lastIndexOf('@');
  if (at === -1) return { token: segment, profileId: null };
  const profileId = toInt(segment.slice(at + 1), null);
  // A non-numeric tail means there was no profile suffix - treat the whole
  // segment as the token (e.g. "user@example@2" only splits when tail is 1-6).
  if (profileId === null || profileId < 1 || profileId > 6) {
    return { token: segment, profileId: null };
  }
  return { token: segment.slice(0, at), profileId };
}

export default {
  async fetch(request, env, ctx) {
    const cfg = getConfig(env || {});
    const url = new URL(request.url);

    // ---- CORS preflight (protocol mandates it on every route) ----
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ---- Login endpoint (GitHub Pages sign-in form) ----
    // Must be matched before the /t/<token> routing below: it takes
    // credentials in the body, not a token in the path.
    const bare = url.pathname.replace(/^\/+|\/+$/g, '');
    if (bare === 'login' || bare.endsWith('/login')) {
      if (request.method !== 'POST') {
        return json({ error: 'method_not_allowed', hint: 'POST { email, password }' }, 405);
      }
      return handleLogin(request, cfg);
    }

    // Stremio account link (produces the authKey for library write-back).
    if (bare === 'stremio-login' || bare.endsWith('/stremio-login')) {
      if (request.method !== 'POST') {
        return json({ error: 'method_not_allowed', hint: 'POST { email, password }' }, 405);
      }
      return handleStremioLogin(request, cfg);
    }

    // ---- Frontend (fix #5: no separate host - the Worker serves the page) ----
    if (url.pathname === '/' || url.pathname === '/index.html') {
      // Per-request nonce: every <script> in the page gets this exact value
      // and the CSP only permits that nonce, so injected script tags are dead
      // on arrival.
      const nonce = crypto.randomUUID().replace(/-/g, '');
      const html = INDEX_HTML.replace(/<script/g, `<script nonce="${nonce}"`);
      return new Response(html, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          ...CORS_HEADERS,
          ...securityHeaders(nonce),
        },
      });
    }

    try {
      const segments = url.pathname.split('/').filter(Boolean).map(safeDecode);

      // ---- Resolve optional /t/<token>@<profile> prefix ----------------
      let idx = 0;
      let token = null;
      let stremioKey = null;
      let profileId = cfg.defaultProfileId;

      if (segments[0] === 't' && segments[1]) {
        const parsed = parseTokenSegment(segments[1]);
        token = parsed.token || null;
        if (parsed.profileId && parsed.profileId >= 1 && parsed.profileId <= 6) {
          profileId = parsed.profileId;
        }
        idx = 2;

        // Optional /s/<stremioAuthKey> - enables writing resume points back
        // into the user's Stremio account (Nuvio -> Stremio resume).
        if (segments[2] === 's' && segments[3]) {
          stremioKey = segments[3];
          idx = 4;
        }
      } else if (segments[0] === 's' && segments[1]) {
        // Stremio-only install (no Nuvio token): still usable for the
        // catalog-less case, though sync needs the Nuvio token.
        stremioKey = segments[1];
        idx = 2;
      }

      // Fallback: tokens may arrive as query params on the manifest URL.
      if (!token) token = url.searchParams.get('nuvioToken');
      if (!stremioKey) stremioKey = url.searchParams.get('stremioKey');

      const rest = segments.slice(idx);
      const head = rest[0];

      // ---- manifest ------------------------------------------------------
      // Both apps fetch the manifest on open (and periodically). For a linked
      // install we use it as the automatic sync point: Nuvio progress is
      // pulled and written into the Stremio account BEFORE the response is
      // returned, so by the time the client renders its boards and pulls its
      // library, the resume points are already there. Without this, the only
      // trigger was the user manually opening the Continue Watching row.
      if (!head || head === 'manifest.json' || head.startsWith('manifest.json?')) {
        if (token && stremioKey) {
          await autoSyncFromManifest(cfg, token, profileId, stremioKey);
        }
        return json(buildManifest());
      }

      // Routes below all require a token; without one we cannot sync.
      if (!token) {
        return json(
          { error: 'missing_token', hint: 'install URL must be /t/<nuvioToken>@<profile>/manifest.json' },
          400
        );
      }

      // ---- self-check page (replaces "run wrangler tail" for users) --------
      if (head === 'debug') {
        return await handleDebug(cfg, token, profileId, stremioKey);
      }

      // ---- health probe (used by the GitHub Pages UI to test a token) ----
      if (head === 'health') {
        try {
          // sync_pull_profiles validates the token and lists profile indices.
          const profiles = await nuvioRpc(cfg, token, 'sync_pull_profiles', {});
          return json({ ok: true, profileId, profiles });
        } catch (err) {
          return json({ ok: false, error: err.message }, 401);
        }
      }

      // ---- catalog / stream / player / library ---------------------------
      if (head === 'catalog' && rest.length >= 3) {
        const type = rest[1];
        const catalogId = rest[2].replace(/\.json$/i, '');
        return await handleCatalog(type, catalogId, cfg, token, profileId, stremioKey, ctx);
      }

      if (head === 'stream' && rest.length >= 3) {
        const type = rest[1];
        const id = rest[2].replace(/\.json$/i, '');
        return handleStreamRequest(type, id);
      }

      if (head === 'player' && rest.length >= 3) {
        const type = rest[1];
        const videoId = rest[2];
        // rest[3] carries action=..&currentTime=..&duration=.. (with .json)
        const extra = rest[3] || '';
        return await handlePlayerEvent(type, videoId, extra, cfg, token, profileId, stremioKey, ctx);
      }

      if (head === 'library' && rest.length >= 3) {
        const type = rest[1];
        const id = rest[2];
        const extra = rest[3] || '';
        return await handleLibraryEvent(type, id, extra, cfg, token, profileId);
      }

      return json({ error: 'not_found', path: url.pathname }, 404);
    } catch (err) {
      // The router must never take the player down with it.
      console.error(`[router] unhandled error: ${err && err.stack ? err.stack : err}`);
      return json({ error: 'internal_error' }, 500);
    }
  },
};

// ---------------------------------------------------------------------------
// MANIFEST
// ---------------------------------------------------------------------------

/**
 * The addon manifest. Declares:
 *  - a "Continue Watching" catalog for movie + series (Nuvio -> Stremio)
 *  - the `player` event resource (Stremio -> Nuvio live position)
 *  - the `library` event resource (watched-state sync)
 *  - `stream` (empty stream list, heartbeat only)
 *
 * idPrefixes: ["tt"] means Stremio only routes IMDb-tt ids to us - which is
 * exactly the id space both Stremio and Nuvio use for this content.
 */
function buildManifest() {
  return {
    id: 'org.stremionuvio.sync.bridge',
    version: '1.0.0',
    name: 'Nuvio Live Sync',
    description:
      'Bridges live playback position and watched-state between Stremio and Nuvio. ' +
      'Stateless, no data stored. Declares the player event resource to receive ' +
      'start/pause/stop with the current playback position.',
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [
      {
        type: 'movie',
        id: 'nuviocw',
        name: 'Continue Watching (Nuvio)',
        extra: [{ name: 'skip', isRequired: false }],
      },
      {
        type: 'series',
        id: 'nuviocw',
        name: 'Continue Watching (Nuvio)',
        extra: [{ name: 'skip', isRequired: false }],
      },
      {
        type: 'movie',
        id: 'nuviowatched',
        name: 'Watched (Nuvio)',
        extra: [{ name: 'skip', isRequired: false }],
      },
      {
        type: 'series',
        id: 'nuviowatched',
        name: 'Watched (Nuvio)',
        extra: [{ name: 'skip', isRequired: false }],
      },
    ],
    resources: [
      { name: 'catalog', types: ['movie', 'series'], idPrefixes: ['tt'] },
      { name: 'stream', types: ['movie', 'series'], idPrefixes: ['tt'] },
      { name: 'player', types: ['movie', 'series'], idPrefixes: ['tt'] },
      { name: 'library', types: ['movie', 'series'], idPrefixes: ['tt'] },
    ],
    behaviorHints: { adult: false, p2p: false },
  };
}
/**
 * ============================================================================
 *  FRONTEND - the single-page UI, inlined into the Worker.
 * ============================================================================
 *  Fix #5: this used to be hosted on GitHub Pages. It now ships inside the
 *  Worker itself, so there is exactly ONE deploy and ONE host - the page at
 *  https://<worker>/ and the addon at https://<worker>/t/<token>/manifest.json
 *  share an origin (no CORS at all for the sign-in calls).
 *
 *  If you edit this, edit index.html and regenerate the block below (it is a
 *  verbatim copy with ` and ${ escaped for the template literal).
 *
 *  Trade-off: page loads are dynamic requests against the 100k/day free
 *  budget. Static assets (Workers Assets) are free but need the wrangler CLI;
 *  inline is what keeps the dashboard-paste deploy working.
 * ============================================================================
 */
const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Stremio &harr; Nuvio Live Sync</title>
<meta name="description" content="Free, stateless bridge that syncs live playback position and watched-state between Stremio and Nuvio. One addon URL, installed in both apps." />
<meta name="color-scheme" content="dark" />

<!--
  ============================================================================
  Stremio <-> Nuvio Live Sync  ·  frontend (served by the Cloudflare Worker)
  ============================================================================
  What this page does, and all it does:

    1. Signs the user in to Nuvio (email + password, exchanged by the Worker
       against api.nuvio.tv - the password is never stored, never logged).
    2. Optionally links their Stremio account (authKey) so that Nuvio progress
       actually RESUMES inside Stremio, not just displays.
    3. Builds ONE addon URL containing both credentials in its path:
           https://<worker>/t/<nuvioToken>@<profile>/s/<stremioKey>/manifest.json
       The same URL is installed in Stremio AND Nuvio.

  No database, no accounts, no tracking, no third-party requests of any kind:
  the page only ever talks to its own Worker.
  ============================================================================
-->

<style>
  :root {
    --bg: #07070b;
    --bg-grad-1: #12101f;
    --bg-grad-2: #0a0a12;
    --surface: rgba(255, 255, 255, 0.028);
    --surface-2: rgba(255, 255, 255, 0.05);
    --border: rgba(255, 255, 255, 0.08);
    --border-strong: rgba(255, 255, 255, 0.14);
    --text: #f2f2f7;
    --text-dim: #9a9ab4;
    --text-faint: #6a6a85;
    --accent: #8b5cf6;
    --accent-2: #6366f1;
    --accent-soft: rgba(139, 92, 246, 0.14);
    --ok: #34d399;
    --ok-soft: rgba(52, 211, 153, 0.12);
    --err: #f87171;
    --err-soft: rgba(248, 113, 113, 0.12);
    --radius: 16px;
    --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  }

  * { box-sizing: border-box; }

  html { -webkit-text-size-adjust: 100%; }

  body {
    margin: 0;
    min-height: 100vh;
    background:
      radial-gradient(1100px 600px at 50% -180px, var(--bg-grad-1), transparent 70%),
      radial-gradient(900px 500px at 85% 110%, rgba(99, 102, 241, 0.07), transparent 70%),
      var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }

  .wrap { max-width: 720px; margin: 0 auto; padding: 56px 20px 72px; }

  /* ---------------- header ---------------- */
  header { text-align: center; margin-bottom: 40px; }

  .mark {
    width: 64px; height: 64px; margin: 0 auto 20px;
    border-radius: 18px;
    background: linear-gradient(140deg, var(--accent), var(--accent-2));
    display: grid; place-items: center;
    box-shadow: 0 12px 40px -12px rgba(139, 92, 246, 0.65),
                inset 0 1px 0 rgba(255, 255, 255, 0.25);
  }
  .mark svg { width: 32px; height: 32px; }

  header h1 {
    font-size: clamp(26px, 5vw, 34px);
    margin: 0 0 10px;
    letter-spacing: -0.03em;
    font-weight: 700;
  }
  header h1 .grad {
    background: linear-gradient(92deg, #c4b5fd, #8b5cf6 45%, #6366f1);
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  header p {
    color: var(--text-dim); margin: 0 auto; max-width: 46ch;
    font-size: 15.5px;
  }

  /* ---------------- cards ---------------- */
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 26px;
    margin-bottom: 18px;
    backdrop-filter: blur(6px);
  }
  .card.hidden { display: none; }

  .step-head { display: flex; align-items: center; gap: 13px; margin-bottom: 6px; }
  .step-num {
    flex: none;
    width: 27px; height: 27px; border-radius: 50%;
    background: var(--accent-soft);
    border: 1px solid rgba(139, 92, 246, 0.35);
    color: #c4b5fd;
    font-size: 13px; font-weight: 700;
    display: grid; place-items: center;
  }
  .step-head h2 { margin: 0; font-size: 16.5px; font-weight: 650; letter-spacing: -0.01em; }
  .step-head .optional {
    font-size: 11.5px; font-weight: 600; letter-spacing: .04em;
    color: var(--text-faint); text-transform: uppercase;
    border: 1px solid var(--border); border-radius: 999px; padding: 2px 9px;
  }
  .card .sub { color: var(--text-dim); font-size: 13.5px; margin: 0 0 20px; }

  /* ---------------- forms ---------------- */
  label { display: block; font-size: 12.5px; font-weight: 550; color: var(--text-dim); margin: 0 0 7px; }

  input[type="text"], input[type="email"], input[type="password"], input[type="number"] {
    width: 100%; padding: 12px 14px;
    border-radius: 11px;
    border: 1px solid var(--border);
    background: rgba(0, 0, 0, 0.28);
    color: var(--text);
    font-size: 14.5px;
    font-family: inherit;
    outline: none;
    transition: border-color .15s, box-shadow .15s, background .15s;
  }
  input.mono { font-family: var(--mono); font-size: 13.5px; }
  input::placeholder { color: var(--text-faint); }
  input:focus {
    border-color: rgba(139, 92, 246, 0.6);
    box-shadow: 0 0 0 3px rgba(139, 92, 246, 0.14);
    background: rgba(0, 0, 0, 0.4);
  }
  input[type="number"] { text-align: center; }

  .row { display: flex; gap: 12px; flex-wrap: wrap; }
  .row > .field { flex: 1 1 200px; min-width: 0; }
  .row > .field.tiny { flex: 0 0 92px; }

  .field { margin-bottom: 16px; }

  /* ---------------- buttons ---------------- */
  button {
    cursor: pointer; border: none; border-radius: 11px;
    font-size: 14px; font-weight: 600; font-family: inherit;
    padding: 12px 20px;
    transition: filter .15s, transform .06s, border-color .15s, background .15s;
  }
  button:active { transform: translateY(1px); }
  button:disabled { opacity: .55; cursor: default; }

  .btn-primary {
    background: linear-gradient(92deg, var(--accent), var(--accent-2));
    color: #fff;
    box-shadow: 0 8px 24px -10px rgba(139, 92, 246, 0.7);
  }
  .btn-primary:hover:not(:disabled) { filter: brightness(1.12); }

  .btn-ghost {
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
  }
  .btn-ghost:hover:not(:disabled) { border-color: var(--border-strong); background: rgba(255, 255, 255, 0.08); }

  .btn-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }

  /* ---------------- status banners ---------------- */
  .status { display: none; margin-top: 14px; font-size: 13.5px; border-radius: 11px; padding: 11px 14px; border: 1px solid transparent; }
  .status.show { display: block; }
  .status.ok { color: var(--ok); background: var(--ok-soft); border-color: rgba(52, 211, 153, 0.25); }
  .status.err { color: var(--err); background: var(--err-soft); border-color: rgba(248, 113, 113, 0.25); }
  .status.info { color: var(--text-dim); background: var(--surface-2); border-color: var(--border); }

  /* ---------------- url panel ---------------- */
  .panel {
    margin-top: 20px; padding: 18px;
    border-radius: 13px;
    background: linear-gradient(180deg, rgba(139, 92, 246, 0.09), rgba(139, 92, 246, 0.03));
    border: 1px solid rgba(139, 92, 246, 0.22);
  }
  .panel .field { display: flex; gap: 8px; }
  .panel input { flex: 1; min-width: 0; }

  .qr-area { display: flex; gap: 20px; align-items: center; flex-wrap: wrap; margin-top: 16px; }
  #qrcode { background: #fff; padding: 9px; border-radius: 11px; display: none; line-height: 0; }
  #qrcode.show { display: block; }
  .qr-note { font-size: 12.5px; color: var(--text-dim); max-width: 30ch; }

  .hint { font-size: 12.5px; color: var(--text-faint); margin: 10px 0 0; }
  .hint.warn { color: #fbbf24; }

  a.link { color: #a78bfa; text-decoration: none; font-weight: 550; }
  a.link:hover { text-decoration: underline; }

  /* ---------------- install cards ---------------- */
  .install-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); margin-top: 18px; }
  .install {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 13px;
    padding: 16px;
  }
  .install h3 { margin: 0 0 6px; font-size: 14px; display: flex; align-items: center; gap: 8px; }
  .install p { margin: 0; font-size: 12.8px; color: var(--text-dim); }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); flex: none; }

  code, .inline-code {
    font-family: var(--mono); font-size: 12.3px;
    background: rgba(0, 0, 0, 0.35);
    border: 1px solid var(--border);
    border-radius: 6px; padding: 1.5px 6px; color: #c4b5fd;
  }

  /* ---------------- details / how it works ---------------- */
  details {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin-bottom: 18px;
    overflow: hidden;
  }
  summary {
    cursor: pointer; list-style: none;
    padding: 18px 22px;
    font-size: 14.5px; font-weight: 600;
    display: flex; align-items: center; justify-content: space-between;
  }
  summary::-webkit-details-marker { display: none; }
  summary::after {
    content: ""; width: 8px; height: 8px;
    border-right: 1.6px solid var(--text-faint); border-bottom: 1.6px solid var(--text-faint);
    transform: rotate(45deg); transition: transform .2s;
  }
  details[open] summary::after { transform: rotate(-135deg); }
  .details-body { padding: 0 22px 22px; }
  .details-body p, .details-body li { font-size: 13.2px; color: var(--text-dim); }
  .details-body ul { padding-left: 20px; margin: 8px 0; }

  table.spec { width: 100%; border-collapse: collapse; font-size: 12.6px; margin-top: 12px; }
  table.spec th, table.spec td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  table.spec th { color: var(--text-faint); font-weight: 600; white-space: nowrap; }
  table.spec tr:last-child td { border-bottom: none; }

  /* ---------------- footer ---------------- */
  footer { text-align: center; color: var(--text-faint); font-size: 12.5px; margin-top: 28px; }
  footer .sep { margin: 0 8px; opacity: .5; }

  @media (max-width: 560px) {
    .wrap { padding: 36px 16px 56px; }
    .card { padding: 20px; }
    .card .sub { margin-bottom: 16px; }
  }
</style>
</head>
<body>
<div class="wrap">

  <header>
    <div class="mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 12a9 9 0 1 1-2.64-6.36" />
        <path d="M21 3v6h-6" />
        <path d="M12 7v5l3 2" />
      </svg>
    </div>
    <h1><span class="grad">Stremio &harr; Nuvio</span> Live Sync</h1>
    <p>Watch in one app, resume in the other &mdash; at the exact position. One addon link,
       installed in both. Nothing is ever stored.</p>
  </header>

  <!-- ==================== STEP 1: Nuvio ==================== -->
  <section class="card">
    <div class="step-head">
      <span class="step-num">1</span>
      <h2>Sign in to Nuvio</h2>
    </div>
    <p class="sub">The same login you use in the Nuvio app. It is exchanged for a token and
       discarded immediately &mdash; never stored, never logged.</p>

    <div class="row">
      <div class="field">
        <label for="email">Nuvio email</label>
        <input id="email" type="email" placeholder="you@example.com" autocomplete="username" spellcheck="false" />
      </div>
      <div class="field tiny">
        <label for="profile">Profile</label>
        <input id="profile" type="number" min="1" max="6" step="1" value="1" title="Nuvio profile number (1-6)" />
      </div>
    </div>

    <div class="field">
      <label for="password">Password</label>
      <input id="password" type="password" placeholder="Your Nuvio password" autocomplete="current-password" />
    </div>

    <div class="btn-row">
      <button id="signin" class="btn-primary">Sign in</button>
      <button id="reset" class="btn-ghost" type="button">Clear saved</button>
    </div>

    <div id="signinStatus" class="status"></div>

    <div id="signedInAs" class="status" style="display:none">
      <button id="generate" class="btn-primary">Generate add-on link</button>
    </div>
  </section>

  <!-- ==================== STEP 2: Stremio (optional) ==================== -->
  <section class="card hidden" id="stremioLink">
    <div class="step-head">
      <span class="step-num">2</span>
      <h2>Link Stremio</h2>
      <span class="optional">optional</span>
    </div>
    <p class="sub">Makes what you watch in <b>Nuvio</b> resume at the right place inside
       <b>Stremio</b>. Without it, Stremio can still show your Nuvio progress &mdash;
       but always starts from zero. Same rules: exchanged once, never stored.</p>

    <div class="row">
      <div class="field">
        <label for="stremioEmail">Stremio email</label>
        <input id="stremioEmail" type="email" placeholder="you@example.com" autocomplete="username" spellcheck="false" />
      </div>
      <div class="field">
        <label for="stremioPassword">Stremio password</label>
        <input id="stremioPassword" type="password" placeholder="Your Stremio password" autocomplete="current-password" />
      </div>
    </div>

    <div class="btn-row">
      <button id="stremioSignin" class="btn-primary">Link Stremio</button>
      <button id="skipStremio" class="btn-ghost" type="button">Skip &mdash; Nuvio only</button>
    </div>

    <div id="stremioStatus" class="status"></div>
  </section>

  <!-- ==================== STEP 3: install ==================== -->
  <section class="card hidden" id="installCard">
    <div class="step-head">
      <span class="step-num">3</span>
      <h2>Install in both apps</h2>
    </div>
    <p class="sub">The same link works in Stremio and Nuvio &mdash; both speak the Stremio addon protocol.</p>

    <div class="panel">
      <label for="addonUrl">Your add-on link</label>
      <div class="field">
        <input id="addonUrl" type="text" class="mono" readonly />
        <button id="copy" class="btn-ghost">Copy</button>
      </div>
      <p class="hint">This link carries your credentials. Treat it like a password &mdash;
         anyone with it can read and write your Nuvio progress.</p>

      <div class="qr-area">
        <div id="qrcode" title="Scan with Nuvio TV: Manage from phone"></div>
        <p class="qr-note">Scan with <b>Nuvio TV</b> &rarr; <i>Manage from phone</i>,
           or copy the link on your phone and open this page there.</p>
      </div>

      <div class="btn-row" style="margin-top:16px">
        <a id="debugLink" href="#" target="_blank" rel="noopener" class="link">Run sync self-check &rarr;</a>
      </div>
      <p class="hint">Verifies both logins, counts your Continue Watching items, shows what
         will sync next, and lists the playback events seen so far.</p>
    </div>

    <div class="install-grid">
      <div class="install">
        <h3><span class="dot"></span>Stremio</h3>
        <p>Add-ons &rarr; paste the link &rarr; Install. Use the <b>same profile number</b> you use on your other device.</p>
      </div>
      <div class="install">
        <h3><span class="dot"></span>Nuvio (mobile / desktop)</h3>
        <p>Settings &rarr; Content &amp; Discovery &rarr; Addons &rarr; paste the link &rarr; Install.</p>
      </div>
      <div class="install">
        <h3><span class="dot"></span>Nuvio TV</h3>
        <p>Addons &rarr; <i>Manage from phone</i> &rarr; scan the QR code above.</p>
      </div>
      <div class="install">
        <h3><span class="dot"></span>Then</h3>
        <p>Watch anything in either app and open the other &mdash; it resumes at the exact position.</p>
      </div>
    </div>
  </section>

  <details>
    <summary>How it works</summary>
    <div class="details-body">
      <p>The addon is a stateless Cloudflare Worker. It speaks the Stremio addon protocol
         and uses your two accounts as its only &ldquo;database&rdquo; &mdash; reading and writing
         each side directly through their own APIs.</p>

      <table class="spec">
        <tr><th>When</th><th>What happens</th></tr>
        <tr>
          <td>You open either app</td>
          <td>The app fetches the manifest; the Worker syncs both directions immediately &mdash; no need to open any particular row.</td>
        </tr>
        <tr>
          <td><code>/player/...</code> events</td>
          <td>Start, pause, seek and stop (including abrupt app exit) carry the exact position in ms and are pushed to Nuvio and written into your Stremio library.</td>
        </tr>
        <tr>
          <td>Stremio &rarr; Nuvio</td>
          <td>Positions are read from your Stremio account (<code>libraryItem.state.timeOffset</code>) and pushed to Nuvio &mdash; this works even if your Stremio build never emits player events.</td>
        </tr>
        <tr>
          <td>Nuvio &rarr; Stremio</td>
          <td>Progress is written into your Stremio account as library items with <code>state.timeOffset</code>, which is what Stremio's own Continue Watching reads to resume.</td>
        </tr>
        <tr>
          <td>Rows in Stremio</td>
          <td><i>Continue Watching (Nuvio)</i> and <i>Watched (Nuvio)</i> are populated from your Nuvio account; titles and posters come from your own libraries.</td>
        </tr>
        <tr>
          <td>Watched marks</td>
          <td>Marking watched in either app writes to the other's history.</td>
        </tr>
      </table>

      <p style="margin-top:16px"><b>Privacy:</b> nothing is stored anywhere &mdash; no database,
         no accounts, no analytics, no logs of your credentials or tokens. Every request reads
         the credentials from its own URL, uses them for one call to Nuvio's or Stremio's API,
         and discards them. Revoke access instantly by uninstalling the addon in both apps.</p>
    </div>
  </details>

  <details>
    <summary>Advanced: paste a token instead</summary>
    <div class="details-body">
      <p>If you already have a Nuvio access token, use it directly instead of signing in.</p>
      <div class="field">
        <input id="token" type="text" class="mono" placeholder="Nuvio access token" autocomplete="off" spellcheck="false" />
      </div>
      <button id="useToken" class="btn-ghost">Use this token</button>
    </div>
  </details>

  <footer>
    100% free &amp; open<span class="sep">·</span>Cloudflare Workers<span class="sep">·</span>no database<span class="sep">·</span>no accounts<span class="sep">·</span>no tracking
  </footer>
</div>

<!-- QR codes for TV installs (optional; the page works without it) -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>

<script>
(function () {
  "use strict";

  // ---- Elements ------------------------------------------------------------
  var $ = function (id) { return document.getElementById(id); };
  var emailInput = $("email");
  var passwordInput = $("password");
  var profileInput = $("profile");
  var tokenInput = $("token");
  var signinBtn = $("signin");
  var useTokenBtn = $("useToken");
  var resetBtn = $("reset");
  var signinStatus = $("signinStatus");
  var signedInAs = $("signedInAs");
  var generateBtn = $("generate");
  var urlBox = $("installCard");
  var addonUrlInput = $("addonUrl");
  var copyBtn = $("copy");
  var qrHost = $("qrcode");
  var debugLink = $("debugLink");

  var LS_KEY = "nuvio-sync-prefs";

  /**
   * The deployed Worker. Hardcoded so users never see or type a backend URL -
   * the page only ever asks for their credentials. If the Worker is ever
   * redeployed to a new address, change this one line.
   */
  var WORKER_URL = "https://numio-sync.vijaykumar-f83.workers.dev";

  /**
   * Credentials, held in memory only. Deliberately NOT written to
   * localStorage: they are bearer credentials (the Nuvio token lives ~1 hour),
   * so persisting them buys nothing and costs exposure.
   */
  var accessToken = null;   // Nuvio access token
  var stremioKey = null;    // Stremio authKey (optional - enables resume)

  // ---- Persistence (this browser only, for convenience) --------------------
  function loadPrefs() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      var prefs = JSON.parse(raw);
      if (prefs.profile) profileInput.value = prefs.profile;
    } catch (e) { /* storage unavailable - ignore */ }
  }
  function savePrefs() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ profile: profileInput.value }));
    } catch (e) { /* storage unavailable - ignore */ }
  }

  // ---- URL building --------------------------------------------------------
  /**
   * Build the addon manifest URL.
   *
   * Shape:  https://<worker>/t/<accessToken>@<profile>[/s/<stremioAuthKey>]/manifest.json
   *
   * Why the credentials are in the PATH and not the query string: Stremio's
   * HTTP transport derives every later resource request from the directory
   * the manifest was installed from, so the /t/<token>/ prefix is re-applied
   * automatically to every player/catalog/library request. Query strings on
   * the manifest URL are NOT preserved by the client.
   */
  function buildAddonUrl(token) {
    var profile = parseInt(profileInput.value, 10) || 1;
    var url = WORKER_URL + "/t/" + encodeURIComponent(token) + "@" + profile;
    // /s/<stremioAuthKey> enables the Nuvio -> Stremio resume write-back.
    if (stremioKey) url += "/s/" + encodeURIComponent(stremioKey);
    return url + "/manifest.json";
  }

  // ---- Helpers -------------------------------------------------------------
  function setStatus(el, msg, kind) {
    el.innerHTML = msg;
    el.className = "status show " + (kind || "");
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ---- Sign in to Nuvio ------------------------------------------------------
  /**
   * Exchange the user's Nuvio credentials for an access token:
   *   POST <worker>/login  { email, password }
   *     -> Worker calls api.nuvio.tv/auth/v1/token?grant_type=password
   *     -> returns ONLY { access_token, expires_in, profiles }
   *
   * The password is used once and discarded by the Worker; nothing is stored
   * or logged. The returned token is kept in memory (never localStorage) and
   * embedded only in the addon link the user installs.
   */
  function signIn() {
    var email = emailInput.value.trim();
    var password = passwordInput.value;
    if (!email || !password) {
      setStatus(signinStatus, "Enter your Nuvio email and password.", "err");
      return;
    }

    savePrefs();
    signinBtn.disabled = true;
    setStatus(signinStatus, "Signing in&hellip;", "info");
    passwordInput.value = ""; // never keep the password in the DOM

    fetch(WORKER_URL + "/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email, password: password })
    })
      .then(function (res) {
        return res.json().then(function (body) { return { ok: res.ok, body: body }; });
      })
      .then(function (r) {
        if (r.ok && r.body && r.body.ok && r.body.access_token) {
          accessToken = r.body.access_token;
          var names = Array.isArray(r.body.profiles) && r.body.profiles.length
            ? r.body.profiles.map(function (p) { return escapeHtml(p.name || "Profile") + " #" + escapeHtml(p.index); }).join(", ")
            : null;
          setStatus(signinStatus,
            "Signed in" + (names ? " &mdash; profiles: " + names : "") +
            ". The token is valid for about " + Math.round((r.body.expires_in || 3600) / 60) +
            " minutes; if syncing stops later, sign in again to refresh it.", "ok");
          signedInAs.style.display = "block";
          $("stremioLink").classList.remove("hidden");
          $("stremioLink").scrollIntoView({ behavior: "smooth", block: "start" });
        } else {
          setStatus(signinStatus, "Sign-in failed" + (r.body && r.body.error ? ": " + escapeHtml(r.body.error) : ""), "err");
        }
      })
      .catch(function () {
        setStatus(signinStatus, "Could not reach the Worker. Check your connection and try again.", "err");
      })
      .then(function () { signinBtn.disabled = false; });
  }

  // ---- Link Stremio ----------------------------------------------------------
  /**
   * Link the user's Stremio account:
   *   POST <worker>/stremio-login  { email, password }
   *     -> Worker calls api.strem.io/api/login, validates with getUser
   *     -> returns ONLY { authKey, user }
   *
   * The authKey lets the Worker write resume points into the user's Stremio
   * library (libraryItem.state.timeOffset). The password is cleared from the
   * DOM the moment it is sent; neither credential is stored.
   */
  function stremioSignIn() {
    var email = $("stremioEmail").value.trim();
    var password = $("stremioPassword").value;
    var statusEl = $("stremioStatus");
    if (!email || !password) {
      setStatus(statusEl, "Enter your Stremio email and password.", "err");
      return;
    }
    setStatus(statusEl, "Linking Stremio&hellip;", "info");
    $("stremioPassword").value = "";

    fetch(WORKER_URL + "/stremio-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email, password: password })
    })
      .then(function (res) {
        return res.json().then(function (body) { return { ok: res.ok, body: body }; });
      })
      .then(function (r) {
        if (r.ok && r.body && r.body.ok && r.body.authKey) {
          stremioKey = r.body.authKey;
          setStatus(statusEl,
            "Stremio linked" + (r.body.user && r.body.user.email ? " as " + escapeHtml(r.body.user.email) : "") +
            " &mdash; Nuvio progress will now resume inside Stremio.", "ok");
          $("stremioSignin").style.display = "none";
          $("skipStremio").style.display = "none";
          $("stremioLink").scrollIntoView({ behavior: "smooth", block: "start" });
        } else {
          setStatus(statusEl, "Stremio link failed" + (r.body && r.body.error ? ": " + escapeHtml(r.body.error) : ""), "err");
        }
      })
      .catch(function () {
        setStatus(statusEl, "Could not reach the Worker.", "err");
      });
  }

  // ---- Advanced manual-token path --------------------------------------------
  function useManualToken() {
    var t = tokenInput.value.trim();
    if (!t) { setStatus(signinStatus, "Paste a token first.", "err"); return; }
    accessToken = t;
    setStatus(signinStatus, "Using the pasted token.", "ok");
    signedInAs.style.display = "block";
    $("stremioLink").classList.remove("hidden");
  }

  // ---- QR code (optional enhancement) ---------------------------------------
  function renderQr(url) {
    qrHost.innerHTML = "";
    qrHost.classList.remove("show");
    if (typeof QRCode === "undefined") return; // CDN blocked - skip quietly
    try {
      new QRCode(qrHost, { text: url, width: 168, height: 168, correctLevel: QRCode.CorrectLevel.M });
      qrHost.classList.add("show");
    } catch (e) { /* ignore */ }
  }

  // ---- Generate ----------------------------------------------------------------
  function generate() {
    if (!accessToken) {
      setStatus(signinStatus, "Sign in to Nuvio first.", "err");
      return;
    }
    var url = buildAddonUrl(accessToken);
    addonUrlInput.value = url;
    // The self-check lives at the same path with /manifest.json swapped out.
    debugLink.href = url.replace(/\\/manifest\\.json$/, "/debug");
    urlBox.classList.remove("hidden");
    renderQr(url);
    urlBox.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---- Wiring -------------------------------------------------------------------
  signinBtn.addEventListener("click", signIn);
  passwordInput.addEventListener("keydown", function (e) { if (e.key === "Enter") signIn(); });
  $("stremioSignin").addEventListener("click", stremioSignIn);
  $("stremioPassword").addEventListener("keydown", function (e) { if (e.key === "Enter") stremioSignIn(); });
  $("skipStremio").addEventListener("click", function () {
    $("stremioLink").classList.add("hidden");
    setStatus($("stremioStatus"), "", "");
  });
  useTokenBtn.addEventListener("click", useManualToken);
  resetBtn.addEventListener("click", function () {
    try { localStorage.removeItem(LS_KEY); } catch (e) {}
    emailInput.value = ""; passwordInput.value = ""; profileInput.value = "1";
    accessToken = null; stremioKey = null;
    signedInAs.style.display = "none";
    $("stremioLink").classList.add("hidden");
    urlBox.classList.add("hidden");
    setStatus(signinStatus, "Saved details cleared.", "info");
  });
  copyBtn.addEventListener("click", function () {
    addonUrlInput.select();
    var done = function () { copyBtn.textContent = "Copied"; setTimeout(function () { copyBtn.textContent = "Copy"; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(addonUrlInput.value).then(done, function () { document.execCommand("copy"); done(); });
    } else {
      document.execCommand("copy"); done();
    }
  });
  generateBtn.addEventListener("click", generate);

  loadPrefs();
})();
</script>
</body>
</html>
`;
