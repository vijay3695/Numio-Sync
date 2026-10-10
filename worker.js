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
 * `temp: true` keeps the item out of the user's library while still storing
 * the resume point (mirrors what Stremio itself does for played-but-not-added
 * titles). Set STREMIO_PROGRESS_TEMP=false to also pin items into the library.
 */
const STREMIO_PROGRESS_TEMP_DEFAULT = true;

/**
 * Metadata providers, tried in order until one answers.
 *
 * Cinemeta is the default Stremio metadata source, but it is a single third
 * party that goes down (all strem.fun mirrors returning 530 at once). TMDB
 * is used as a reliable fallback when NUVIO_TMDB_KEY (a free TMDB API key)
 * is configured - without a key only the Cinemeta mirrors are used.
 */
const CINEMETA_MIRRORS = [
  'https://v3-cinemeta.strem.fun',
  'https://v2-cinemeta.strem.fun',
  'https://cinemeta.strem.fun',
];

/** Our own addon id - used to exclude ourselves from the user's addon list
 *  when proxying metadata (prevents infinite recursion). */
const OUR_ADDON_ID = 'org.stremionuvio.sync.bridge';

/** Separate caches for the user's addon list and their manifests. */
const addonListCache = new Map();  // key -> { expires, value: string[] }
const addonManifestCache = new Map(); // url -> { expires, value: manifest|null }
const ADDON_TTL_MS = 10 * 60 * 1000;
const TMDB_API_DEFAULT = 'https://api.themoviedb.org/3';

/** Profile used when the install URL does not carry `@<profile>`. */
const DEFAULT_PROFILE_ID = 1;

/** Max rows returned by the Continue Watching catalog. */
const CATALOG_LIMIT = 40;

/**
 * Per-isolate in-memory cache for metadata lookups (and their failures).
 * Purely an optimization; a cold isolate simply refetches.
 *
 * Failures get a SHORT ttl (negative cache): when a provider is down we must
 * not retry it on every catalog render - a 40-item row would otherwise mean
 * 40+ doomed requests to a dead origin on every single page load.
 */
const metaCache = new Map(); // key -> { expires, value }
const META_TTL_MS = 10 * 60 * 1000;
const META_FAIL_TTL_MS = 60 * 1000;

// ---------------------------------------------------------------------------
// SMALL HELPERS
// ---------------------------------------------------------------------------

/**
 * CORS is mandatory: "each route, including /manifest.json, must serve
 * CORS headers that allow all origins" - Stremio protocol doc. POST is
 * included because the /login endpoint (used by the GitHub Pages sign-in
 * form) is a cross-origin POST from the Pages origin.
 */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

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

/** Read configuration, letting wrangler env bindings win over defaults. */
function getConfig(env) {
  return {
    nuvioBase: (env.NUVIO_BASE || NUVIO_BASE_DEFAULT).replace(/\/+$/, ''),
    nuvioKey: env.NUVIO_PUB_KEY || NUVIO_PUBLISHABLE_KEY_DEFAULT,
    defaultProfileId: toInt(env.PROFILE_ID, DEFAULT_PROFILE_ID) || DEFAULT_PROFILE_ID,
    // Optional free TMDB API key (themoviedb.org) - enables TMDB as a
    // metadata fallback when all Cinemeta mirrors are down.
    tmdbKey: env.NUVIO_TMDB_KEY || env.TMDB_API_KEY || null,
    tmdbBase: (env.TMDB_API_BASE || TMDB_API_DEFAULT).replace(/\/+$/, ''),
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
  // Optional origin pinning (same as /login).
  const allowed = cfg.allowedOrigin;
  if (allowed) {
    const origin = request.headers.get('Origin') || '';
    if (origin !== allowed) {
      return json({ ok: false, error: 'origin_not_allowed' }, 403);
    }
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
  // Optional origin pinning: set ALLOWED_ORIGIN to your GitHub Pages origin
  // (e.g. https://vijay3695.github.io) to stop this endpoint being used as a
  // generic Nuvio credential-checking oracle. Empty by default.
  const allowed = cfg.allowedOrigin;
  if (allowed) {
    const origin = request.headers.get('Origin') || '';
    if (origin !== allowed) {
      return json({ ok: false, error: 'origin_not_allowed' }, 403);
    }
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

/** Read library items: POST /api/datastoreGet { authKey, collection, ids, all }. */
async function stremioDatastoreGet(cfg, authKey, ids) {
  return stremioApi(cfg, 'datastoreGet', {
    authKey,
    collection: 'libraryItem',
    ids: ids || [],
    all: ids ? false : true,
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
function buildStremioLibraryItem(row, cfg, meta) {
  const type = row.content_type === 'series' ? 'series' : 'movie';
  const position = toInt(row.position, 0);
  const duration = toInt(row.duration, 0);
  const videoId = row.video_id || row.content_id;
  const name = (meta && meta.name) || row.content_id;
  const poster = (meta && meta.poster) || undefined;
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
      lastWatched: isoNow(),
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
 * Is this Nuvio progress row newer than what Stremio already has?
 * Prevents redundant writes (each datastorePut is a request against the
 * free-tier budget, and pointless writes would churn the user's account).
 */
function isNewerThanStremio(row, existing) {
  if (!existing || !existing.state) return true;
  const stremioOffset = toInt(existing.state.timeOffset, 0);
  const stremioLast = existing.state.lastWatched ? Date.parse(existing.state.lastWatched) : 0;
  const nuvioLast = toInt(row.last_watched, 0);
  // Same position already stored -> nothing to do.
  if (stremioOffset === toInt(row.position, 0) && stremioLast >= nuvioLast) return false;
  // No timestamps to compare -> write if the position differs.
  if (!nuvioLast && !stremioLast) return stremioOffset !== toInt(row.position, 0);
  return nuvioLast > stremioLast;
}

/**
 * Push a batch of Nuvio progress rows into the user's Stremio account so
 * Stremio's own Continue Watching resumes at the right place.
 *
 * Writes at most STREMIO_WRITE_BATCH items per call; without storage there
 * is no durable queue, so the remainder are simply picked up on the next
 * catalog request (they are still newer than Stremio's copy).
 */
const STREMIO_WRITE_BATCH = 10;

async function syncProgressToStremio(cfg, stremioKey, rows) {
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
      if (!isNewerThanStremio(row, byId.get(row.content_id))) continue;
      try {
        const meta = await fetchMeta(cfg, row.content_type === 'series' ? 'series' : 'movie', row.content_id, null, null);
        await stremioDatastorePut(cfg, stremioKey, [buildStremioLibraryItem(row, cfg, meta)]);
        written += 1;
        console.log(`[stremio] wrote resume point for ${row.content_id} @ ${toInt(row.position, 0)}ms`);
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
async function handlePlayerEvent(type, videoId, extraSegment, cfg, token, profileId, stremioKey) {
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
    try {
      await pushProgressToStremio(cfg, stremioKey, entry);
    } catch (err) {
      console.error(`[player] stremio write-back failed: ${err.message}`);
    }
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
async function handleCatalog(type, catalogId, cfg, token, profileId, stremioKey) {
  // Ignore catalogs we do not declare.
  if (catalogId !== 'nuviocw' && catalogId !== 'nuviowatched') return json({ metas: [] });

  const wantedType = type === 'series' ? 'series' : 'movie';
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

    const meta = await fetchMeta(cfg, wantedType, row.content_id, token, profileId);
    const base = {
      id: row.content_id,
      type: wantedType,
      name: (meta && meta.name) || row.content_id,
      poster: (meta && meta.poster) || undefined,
      posterShape: 'poster',
      releaseInfo: (meta && meta.releaseInfo) || undefined,
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
  // resumes at the right position. Best-effort: failures never fail the row.
  if (stremioKey && catalogId === 'nuviocw') {
    try {
      await syncProgressToStremio(cfg, stremioKey, rows);
    } catch (err) {
      console.error(`[catalog] stremio write-back failed: ${err.message}`);
    }
  }

  return json({ metas: metas.slice(0, CATALOG_LIMIT) });
}

/**
 * Pull the user's installed addon manifest URLs from THEIR Nuvio account.
 *
 * This is the keyless metadata strategy: the "providers" are whatever the
 * user already installed (Cinemeta, a TMDB addon, AIOStreams, Trakt
 * catalogs, a personal Cinemeta mirror, ...). We read their addon list with
 * the token they already gave us and proxy metadata requests to their own
 * addons - no API keys, no third-party trust, no storage.
 *
 * Cached per isolate for ADDON_TTL_MS: every catalog render would otherwise
 * re-fetch the addon list plus N manifests.
 */
async function pullUserAddonUrls(cfg, token, profileId) {
  const key = `addons:${profileId}`;
  const hit = addonListCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  let rows = null;
  try {
    rows = await nuvioRpc(cfg, token, 'sync_pull_addons', { p_profile_id: profileId, p_limit: 100 });
  } catch {
    // Fall back to the direct table read (same auth, same data).
    try {
      const res = await fetch(`${cfg.nuvioBase}/rest/v1/addons?profile_id=eq.${profileId}`, {
        headers: { apikey: cfg.nuvioKey, Authorization: `Bearer ${token}` },
      });
      if (res.ok) rows = await res.json();
    } catch {
      /* unreachable */
    }
  }

  // The addon row shape is not documented, so harvest every URL-looking
  // string from the response instead of guessing field names.
  const urls = new Set();
  const walk = (v) => {
    if (typeof v === 'string') {
      const s = v.trim();
      if (/^https?:\/\//.test(s)) urls.add(s);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === 'object') {
      Object.values(v).forEach(walk);
    }
  };
  walk(rows);

  const list = [...urls];
  addonListCache.set(key, { expires: Date.now() + ADDON_TTL_MS, value: list });
  return list;
}

/** Fetch and cache an addon manifest; returns the parsed manifest or null. */
async function fetchAddonManifest(url) {
  const hit = addonManifestCache.get(url);
  if (hit && hit.expires > Date.now()) return hit.value;

  let manifest = null;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'stremio-nuvio-sync/1.0' } });
    if (res.ok) {
      const data = await res.json();
      // A manifest has id/types/resources; anything else is not an addon.
      if (data && data.id && data.resources) manifest = data;
    }
  } catch {
    /* unreachable addon - skip it */
  }

  addonManifestCache.set(url, { expires: Date.now() + ADDON_TTL_MS, value: manifest });
  return manifest;
}

/**
 * Does this manifest provide meta for our content type?
 * `resources` may be strings ("meta") or objects ({name,types,idPrefixes}).
 */
function manifestProvidesMeta(manifest, type) {
  const resources = Array.isArray(manifest.resources) ? manifest.resources : [];
  return resources.some((r) => {
    const name = typeof r === 'string' ? r : r && r.name;
    if (name !== 'meta') return false;
    if (typeof r === 'object' && r) {
      if (Array.isArray(r.types) && r.types.length && !r.types.includes(type)) return false;
      if (Array.isArray(r.idPrefixes) && r.idPrefixes.length && !r.idPrefixes.includes('tt')) return false;
    }
    return true;
  });
}

/** Base URL of an addon, given its manifest URL. */
function addonBaseUrl(manifestUrl) {
  return manifestUrl.replace(/manifest\.json.*$/i, '');
}

/**
 * Resolve metadata by proxying the user's OWN installed addons, in their
 * order (install order doubles as the client's priority order). Ourselves
 * are excluded to prevent recursion. Returns a Stremio-shaped meta or null.
 */
async function fetchUserProvidedMeta(cfg, token, profileId, type, id) {
  if (!token) return null;

  let urls;
  try {
    urls = await pullUserAddonUrls(cfg, token, profileId);
  } catch {
    return null;
  }

  for (const manifestUrl of urls) {
    let manifest;
    try {
      manifest = await fetchAddonManifest(manifestUrl);
    } catch {
      continue;
    }
    if (!manifest) continue;
    if (manifest.id === OUR_ADDON_ID) continue; // never recurse into ourselves
    if (!manifestProvidesMeta(manifest, type)) continue;

    try {
      const res = await fetch(`${addonBaseUrl(manifestUrl)}/meta/${type}/${id}.json`, {
        headers: { 'User-Agent': 'stremio-nuvio-sync/1.0' },
      });
      if (!res.ok) continue;
      const data = await res.json();
      const meta = data && data.meta ? data.meta : null;
      if (meta && (meta.name || meta.poster)) {
        return { ...meta, id, type };
      }
    } catch {
      /* try the next installed addon */
    }
  }
  return null;
}

/**
 * Look up metadata for an IMDb tt id, trying providers in order:
 *   1. The USER'S OWN installed addons (read from their Nuvio account -
 *      Cinemeta, TMDB addon, AIOStreams, Trakt catalogs, personal mirrors).
 *      Keyless, and it honors whatever the user actually chose.
 *   2. Public Cinemeta mirrors (keyless backup when the user's list is
 *      unavailable - e.g. a metadata request that arrived without a token).
 *   3. TMDB, ONLY if the operator configured a key (off by default).
 *
 * Results - including failures - are cached per isolate. A provider outage
 * therefore costs at most one doomed request per minute, not one per item:
 * without the negative cache a 40-item catalog row would fire 40+ doomed
 * requests at a dead origin on every single page load.
 *
 * Returns a Stremio-shaped meta object ({ id, type, name, poster, ... }) or
 * null when every provider fails.
 */
async function fetchMeta(cfg, type, id, token, profileId) {
  const key = `meta:${type}:${id}:${token ? 'u' : 'p'}`;
  const hit = metaCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  // 1. The user's own installed addons.
  try {
    const userMeta = await fetchUserProvidedMeta(cfg, token, profileId, type, id);
    if (userMeta) {
      metaCache.set(key, { expires: Date.now() + META_TTL_MS, value: userMeta });
      return userMeta;
    }
  } catch {
    /* fall through to public mirrors */
  }

  // 2. Public Cinemeta mirrors.
  for (const base of CINEMETA_MIRRORS) {
    try {
      const res = await fetch(`${base}/meta/${type}/${id}.json`, {
        headers: { 'User-Agent': 'stremio-nuvio-sync/1.0' },
      });
      if (!res.ok) continue; // mirror down - try the next one
      const data = await res.json();
      const meta = data && data.meta ? { ...data.meta, id, type } : { id, type };
      metaCache.set(key, { expires: Date.now() + META_TTL_MS, value: meta });
      return meta;
    } catch {
      /* try next mirror */
    }
  }

  // 3. TMDB fallback (only when the operator configured a key - off by default;
  // the normal path is the user's own installed addons above).
  if (cfg.tmdbKey) {
    try {
      const res = await fetch(`${cfg.tmdbBase}/find/${id}?external_source=imdb_id`, {
        headers: { 'Authorization': `Bearer ${cfg.tmdbKey}`, 'User-Agent': 'stremio-nuvio-sync/1.0' },
      });
      if (res.ok) {
        const data = await res.json();
        const bucket = type === 'series' ? data.tv_results : data.movie_results;
        const item = Array.isArray(bucket) && bucket.length ? bucket[0] : null;
        if (item) {
          const meta = {
            id,
            type,
            name: item.name || item.title || id,
            poster: item.poster_path ? `https://image.tmdb.org/t/p/w300${item.poster_path}` : undefined,
            background: item.backdrop_path ? `https://image.tmdb.org/t/p/w1280${item.backdrop_path}` : undefined,
            description: item.overview || undefined,
            releaseInfo: (item.first_air_date || item.release_date || '').slice(0, 4) || undefined,
            imdbRating: item.vote_average ? String(item.vote_average.toFixed(1)) : undefined,
          };
          metaCache.set(key, { expires: Date.now() + META_TTL_MS, value: meta });
          return meta;
        }
      }
    } catch {
      /* TMDB unreachable */
    }
  }

  // Negative-cache the failure briefly so a dead origin is not retried on
  // every catalog render.
  metaCache.set(key, { expires: Date.now() + META_FAIL_TTL_MS, value: null });
  return null;
}

/**
 * Route: /meta/{type}/{id}.json
 *
 * Serving our own metadata makes catalog items self-contained: when a user
 * clicks an entry in the Continue Watching / Watched rows, the client asks
 * US for the details instead of hunting through every other meta addon -
 * which is exactly what made resolution take ~a minute when Cinemeta was
 * down and the client kept retrying failing providers.
 *
 * Response shape follows the Stremio protocol: { "meta": {...} }.
 */
async function handleMetaRequest(type, id, cfg, token, profileId) {
  const meta = await fetchMeta(cfg, type, id, token, profileId);
  if (!meta) {
    // Minimal but valid fallback so the client never hangs on us.
    return json({ meta: { id, type, name: id } });
  }
  return json({ meta });
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
  async fetch(request, env) {
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
      return new Response(INDEX_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS },
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
      if (!head || head === 'manifest.json' || head.startsWith('manifest.json?')) {
        return json(buildManifest());
      }

      // ---- meta (public data - no token required) --------------------------
      // Metadata for our own catalog rows. Served WITHOUT a token: metadata
      // is public data and the client may request it before/additions.
      if (head === 'meta' && rest.length >= 3) {
        const type = rest[1];
        const id = rest[2].replace(/\.json$/i, '');
        // With a token we resolve via the user's own installed addons;
        // without one we still answer from public keyless mirrors.
        return await handleMetaRequest(type, id, cfg, token, profileId);
      }

      // Routes below all require a token; without one we cannot sync.
      if (!token) {
        return json(
          { error: 'missing_token', hint: 'install URL must be /t/<nuvioToken>@<profile>/manifest.json' },
          400
        );
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
        return await handleCatalog(type, catalogId, cfg, token, profileId, stremioKey);
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
        return await handlePlayerEvent(type, videoId, extra, cfg, token, profileId, stremioKey);
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
      // Our own meta resource makes the Continue Watching / Watched rows
      // self-contained: clicking an item resolves against us (with caching),
      // so the client never has to hunt through other meta addons.
      { name: 'meta', types: ['movie', 'series'], idPrefixes: ['tt'] },
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
<meta name="description" content="Free, stateless addon that bridges live playback position between Stremio and Nuvio." />

<!--
  ============================================================================
  Stremio <-> Nuvio Live Sync  ·  GitHub Pages frontend (single file)
  ============================================================================
  This page does three things and nothing else:

    1. collects the user's Nuvio access token (kept in this browser only,
       optionally in localStorage for convenience - NEVER transmitted
       anywhere except inside the addon URL the user installs themselves),
    2. builds the addon manifest URL of the form
           https://<worker>/t/<nuvioToken>@<profile>/manifest.json
       and shows install links + a QR code for TV devices,
    3. verifies the token against the Worker's /health endpoint, which
       calls Nuvio's sync_pull_profiles.

  It performs no sync itself. All syncing happens in the Cloudflare Worker
  (worker.js) that the generated URL points at - this page is a pure
  static site with zero backend.
  ============================================================================
-->

<style>
  :root {
    --bg: #0a0a0f;
    --bg-card: #12121a;
    --bg-card-2: #1a1a26;
    --border: #262636;
    --text: #e8e8f0;
    --text-dim: #9a9ab0;
    --accent: #8b5cf6;          /* Stremio-ish purple */
    --accent-2: #6366f1;
    --ok: #34d399;
    --err: #f87171;
    --mono: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.55;
  }

  .wrap { max-width: 860px; margin: 0 auto; padding: 32px 20px 64px; }

  header { text-align: center; margin-bottom: 36px; }
  header h1 { font-size: 28px; margin: 0 0 8px; letter-spacing: -0.02em; }
  header h1 .grad {
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  header p { color: var(--text-dim); margin: 0; font-size: 15px; }

  .card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 22px;
    margin-bottom: 22px;
  }
  .card h2 {
    margin: 0 0 4px; font-size: 17px; display: flex; align-items: center; gap: 10px;
  }
  .card h2 .num {
    display: inline-flex; align-items: center; justify-content: center;
    width: 24px; height: 24px; border-radius: 50%;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    font-size: 13px; font-weight: 700; color: #fff; flex: none;
  }
  .card .sub { color: var(--text-dim); font-size: 13.5px; margin: 0 0 16px; }

  label { display: block; font-size: 13px; color: var(--text-dim); margin: 14px 0 6px; }
  input[type="text"], input[type="number"] {
    width: 100%; padding: 11px 13px; border-radius: 9px;
    border: 1px solid var(--border); background: var(--bg-card-2);
    color: var(--text); font-size: 14px; font-family: var(--mono);
    outline: none; transition: border-color .15s;
  }
  input:focus { border-color: var(--accent); }
  .row { display: flex; gap: 12px; flex-wrap: wrap; }
  .row > div { flex: 1 1 220px; }

  button {
    cursor: pointer; border: none; border-radius: 9px; font-size: 14px;
    font-weight: 600; padding: 11px 18px; transition: filter .15s, transform .05s;
  }
  button:active { transform: translateY(1px); }
  .btn-primary {
    background: linear-gradient(90deg, var(--accent), var(--accent-2)); color: #fff;
  }
  .btn-primary:hover { filter: brightness(1.12); }
  .btn-ghost {
    background: var(--bg-card-2); color: var(--text); border: 1px solid var(--border);
  }
  .btn-ghost:hover { border-color: var(--accent); }
  .btn-ghost:disabled, .btn-primary:disabled { opacity: .5; cursor: default; }

  .urlbox {
    margin-top: 16px; display: none;
  }
  .urlbox.show { display: block; }
  .urlbox .field { display: flex; gap: 8px; }
  .urlbox input { flex: 1; }
  .hint { font-size: 12.5px; color: var(--text-dim); margin-top: 8px; }
  .hint.warn { color: #fbbf24; }

  .status { margin-top: 10px; font-size: 13.5px; display: none; }
  .status.show { display: block; }
  .status.ok { color: var(--ok); }
  .status.err { color: var(--err); }

  .steps { margin: 0; padding-left: 0; list-style: none; counter-reset: step; }
  .steps li {
    counter-increment: step; position: relative; padding-left: 34px;
    margin-bottom: 14px; font-size: 14px;
  }
  .steps li::before {
    content: counter(step); position: absolute; left: 0; top: 1px;
    width: 22px; height: 22px; border-radius: 50%;
    background: var(--bg-card-2); border: 1px solid var(--border);
    color: var(--accent); font-size: 12px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
  }
  .steps b { color: var(--text); }
  .steps code, .inline-code {
    background: var(--bg-card-2); border: 1px solid var(--border);
    border-radius: 5px; padding: 1px 6px; font-size: 12.5px; font-family: var(--mono);
    color: var(--accent);
  }

  .qr-area { display: flex; gap: 22px; align-items: center; flex-wrap: wrap; margin-top: 16px; }
  #qrcode {
    background: #fff; padding: 10px; border-radius: 10px; display: none;
  }
  #qrcode.show { display: block; }
  #qrcode img, #qrcode canvas { display: block; }

  details {
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: 14px; padding: 16px 22px; margin-bottom: 22px;
  }
  summary { cursor: pointer; font-weight: 600; font-size: 15px; }
  details[open] summary { margin-bottom: 12px; }
  details p, details li { font-size: 13.5px; color: var(--text-dim); }
  details ul { padding-left: 20px; margin: 8px 0; }

  table.spec { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 10px; }
  table.spec th, table.spec td {
    text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  table.spec th { color: var(--text-dim); font-weight: 600; }
  table.spec td code { font-family: var(--mono); color: var(--accent); font-size: 12px; }

  footer {
    text-align: center; color: var(--text-dim); font-size: 12.5px; margin-top: 8px;
  }
  footer a { color: var(--accent); text-decoration: none; }
</style>
</head>
<body>
<div class="wrap">

  <header>
    <h1><span class="grad">Stremio &harr; Nuvio</span> Live Sync</h1>
    <p>Free &amp; stateless. Sync live playback position and watched-state between
       Stremio and Nuvio &mdash; one addon URL, installed in both apps.</p>
  </header>

  <!-- ================= STEP 1: connect ================= -->
  <section class="card">
    <h2><span class="num">1</span> Sign in to Nuvio</h2>
    <p class="sub">The same login you use in the Nuvio app. Your password is sent to
       this Worker only to exchange it for a Nuvio token &mdash; it is never stored,
       never logged, and the token stays in your browser.</p>

    <div class="row">
      <div>
        <label for="email">Nuvio email</label>
        <input id="email" type="email" placeholder="you@example.com" autocomplete="username" spellcheck="false" />
      </div>
      <div>
        <label for="password">Password</label>
        <input id="password" type="password" placeholder="your Nuvio password" autocomplete="current-password" />
      </div>
      <div style="flex:0 0 110px">
        <label for="profile">Profile #</label>
        <input id="profile" type="number" min="1" max="6" step="1" value="1" />
      </div>
    </div>

    <div class="row" style="margin-top:16px">
      <button id="signin" class="btn-primary">Sign in</button>
      <button id="reset" class="btn-ghost" type="button">Clear saved</button>
    </div>

    <div id="signinStatus" class="status"></div>
    <div id="signedInAs" class="status" style="display:none">
      Signed in &mdash; <button id="generate" class="btn-primary" style="margin-left:8px">Generate add-on URL</button>
    </div>

    <!-- ============ STEP 1b: link Stremio (optional but recommended) ============ -->
    <div id="stremioLink" style="display:none;margin-top:18px;border-top:1px solid var(--border);padding-top:16px">
      <h2 style="font-size:15px;margin:0 0 4px">Link your Stremio account <span style="color:var(--text-dim);font-weight:400">(optional)</span></h2>
      <p class="sub">Makes what you watch in <b>Nuvio</b> resume at the right spot in <b>Stremio</b>.
         Without this, Stremio can show your Nuvio progress but always starts from zero.
         Same rules: exchanged once, never stored, nothing logged.</p>
      <div class="row">
        <div>
          <label for="stremioEmail">Stremio email</label>
          <input id="stremioEmail" type="email" placeholder="you@example.com" autocomplete="username" spellcheck="false" />
        </div>
        <div>
          <label for="stremioPassword">Stremio password</label>
          <input id="stremioPassword" type="password" placeholder="your Stremio password" autocomplete="current-password" />
        </div>
      </div>
      <div class="row" style="margin-top:14px">
        <button id="stremioSignin" class="btn-ghost">Link Stremio</button>
        <button id="skipStremio" class="btn-ghost" type="button">Skip &mdash; Nuvio only</button>
      </div>
      <div id="stremioStatus" class="status"></div>
    </div>

    <details style="margin-top:14px;background:none;border:none;padding:0">
      <summary style="font-size:13px;color:var(--text-dim)">Advanced: paste an access token instead</summary>
      <div style="margin-top:10px">
        <input id="token" type="text" placeholder="paste a Nuvio access token" autocomplete="off" spellcheck="false" />
        <button id="useToken" class="btn-ghost" style="margin-top:8px">Use this token</button>
      </div>
    </details>

    <div id="urlbox" class="urlbox">
      <label>Your personal add-on URL &mdash; install this in both Stremio and Nuvio</label>
      <div class="field">
        <input id="addonUrl" type="text" readonly />
        <button id="copy" class="btn-ghost">Copy</button>
      </div>
      <p class="hint">
        The token lives in the URL path &mdash; that is the whole &ldquo;login&rdquo; system.
        Treat this URL like a password: it grants access to your Nuvio progress.
      </p>
    </div>
  </section>

  <!-- ================= STEP 2: install ================= -->
  <section class="card" id="installCard" style="display:none">
    <h2><span class="num">2</span> Install in your apps</h2>
    <p class="sub">The same URL works in Stremio and Nuvio &mdash; both speak the Stremio addon protocol.</p>

    <div class="qr-area">
      <div id="qrcode" title="Scan with Nuvio TV &rarr; Manage from phone"></div>
      <div>
        <p style="margin:0 0 6px;font-size:14px"><b>Nuvio TV:</b> Addons &rarr; <i>Manage from phone</i> &rarr; scan this QR code</p>
        <p style="margin:0;font-size:13px;color:var(--text-dim)">Phones can also open this page and copy the URL.</p>
      </div>
    </div>

    <ol class="steps" style="margin-top:20px">
      <li><b>Stremio (Desktop / Web / Android / TV):</b>
        open <code>Addons</code> &rarr; paste the URL above &rarr; Install.
        You should see two new rows: <i>Continue Watching (Nuvio)</i> and
        <i>Watched (Nuvio)</i>.</li>
      <li><b>Nuvio (Android / TV / Desktop):</b>
        <code>Settings &rarr; Content &amp; Discovery &rarr; Addons</code> &rarr;
        paste the same URL into <i>Add Addon</i> &rarr; Install.</li>
      <li><b>Watch something in Stremio.</b> Start, pause, seek and close events are
        pushed to your Nuvio account within seconds. Open Nuvio&rsquo;s
        <i>Continue Watching</i> &mdash; the movie is there with its position.</li>
      <li><b>Watch something in Nuvio</b> (or on another device) &rarr; open Stremio&rsquo;s
        <i>Continue Watching (Nuvio)</i> row &rarr; it <b>resumes at the same position</b>
        (requires the linked Stremio account above).</li>
      <li><b>Watch something in Nuvio</b> (if your client also emits player events),
        then open Stremio&rsquo;s <i>Continue Watching (Nuvio)</i> row to resume.</li>
    </ol>
  </section>

  <!-- ================= how it works ================= -->
  <details>
    <summary>How it works (and how to verify it is syncing)</summary>

    <p>The addon is a stateless Cloudflare Worker. It declares the Stremio protocol&rsquo;s
    <b>event resources</b>, which is the part most addons never use: instead of serving
    content, the addon <i>receives</i> your activity.</p>

    <table class="spec">
      <tr><th>Stremio sends</th><th>Worker does</th></tr>
      <tr>
        <td><code>/player/movie/tt0137523/action=start&amp;currentTime=0&amp;duration=7200000.json</code></td>
        <td>Parses <code>action</code>, <code>currentTime</code> (ms), <code>duration</code> (ms) from the path, then POSTs to <code>sync_push_watch_progress</code>.</td>
      </tr>
      <tr>
        <td><code>.../action=pause&amp;currentTime=1830000&amp;duration=7200000.json</code></td>
        <td>Pushes position 1&thinsp;830&thinsp;000&nbsp;ms (30:30) to Nuvio &mdash; that is your resume point.</td>
      </tr>
      <tr>
        <td><code>.../action=stop&amp;currentTime=6900000&amp;duration=7200000.json</code></td>
        <td>Fires even when the player closes or the app exits abruptly. Pushes the final position; Nuvio auto-marks watched at &ge;90%.</td>
      </tr>
      <tr>
        <td><code>/library/movie/tt0137523/action=watched.json</code></td>
        <td>Pushes a watched-history item to Nuvio.</td>
      </tr>
      <tr>
        <td><code>/catalog/movie/nuviocw.json</code> (you opening Stremio)</td>
        <td>Pulls your Nuvio progress and renders the <i>Continue Watching (Nuvio)</i> row.</td>
      </tr>
      <tr>
        <td><code>/catalog/movie/nuviowatched.json</code></td>
        <td>Pulls your Nuvio watch history and renders the <i>Watched (Nuvio)</i> row &mdash; the same list as the <i>Watched</i> tab on your Nuvio account dashboard.</td>
      </tr>
      <tr>
        <td>Stremio account write-back <span style="opacity:.6">(when linked)</span></td>
        <td>Writes <code>libraryItem.state.timeOffset</code> into your Stremio account via Stremio's own API &mdash; the only way Nuvio progress can actually <b>resume</b> in Stremio. Skipping the link leaves this as a display-only row.</td>
      </tr>
    </table>

    <p style="margin-top:14px"><b>Verify it works:</b> the addon operator can run
    <code>npx wrangler tail</code> (or open the Worker&rsquo;s Logs in the Cloudflare dashboard)
    &mdash; every <code>[player]</code> line shows the parsed action, position and duration
    arriving live during playback.</p>

    <p><b>Note:</b> player events are a recent protocol addition. If your Stremio build does
    not send them yet, you will see no <code>[player]</code> lines in the logs &mdash; in that
    case only the catalog row (Nuvio&rarr;Stremio resume) and watched toggles sync.
    Updating Stremio/Nuvio to the latest version is the fix.</p>

    <p><b>Privacy:</b> no server stores anything. Your token is read from the URL on each
    request, used for one call to Nuvio&rsquo;s API, and discarded. You can revoke access
    instantly by regenerating your token or uninstalling the addon in both apps.</p>
  </details>

  <footer>
    100% free &amp; open &middot; GitHub Pages + Cloudflare Workers &middot;
    no database, no accounts, no tracking
  </footer>
</div>

<!-- QR code generator (CDN, optional enhancement - page works without it) -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>

<script>
(function () {
  "use strict";

  // ---- Element handles -----------------------------------------------------
  var $ = function (id) { return document.getElementById(id); };
  var emailInput = $("email");
  var passwordInput = $("password");
  var profileInput = $("profile");
  var tokenInput = $("token");

  /**
   * The deployed Cloudflare Worker. Hardcoded so users never see or type a
   * backend URL - the page only asks for their Nuvio credentials.
   * If the Worker is ever redeployed to a new address, change this one line.
   */
  var WORKER_URL = "https://numio-sync.vijaykumar-f83.workers.dev";
  var signinBtn = $("signin");
  var useTokenBtn = $("useToken");
  var resetBtn = $("reset");
  var signinStatus = $("signinStatus");
  var signedInAs = $("signedInAs");
  var generateBtn = $("generate");
  var urlBox = $("urlbox");
  var addonUrlInput = $("addonUrl");
  var copyBtn = $("copy");
  var installCard = $("installCard");
  var qrHost = $("qrcode");

  var LS_KEY = "nuvio-sync-prefs";

  /**
   * Credentials, held in memory only.
   * Deliberately NOT written to localStorage: they are bearer credentials
   * (the Nuvio token lives ~1 hour), so persisting them buys nothing and
   * costs exposure.
   */
  var accessToken = null;      // Nuvio access token
  var stremioKey = null;       // Stremio authKey (optional - enables resume)

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
      localStorage.setItem(LS_KEY, JSON.stringify({
        profile: profileInput.value
      }));
    } catch (e) { /* storage unavailable - ignore */ }
  }

  // ---- URL building ---------------------------------------------------------
  /**
   * Build the addon manifest URL.
   *
   * Shape:  https://<worker>/t/<accessToken>@<profile>/manifest.json
   *
   * Why the token is in the PATH and not the query string: Stremio's HTTP
   * transport derives every subsequent resource request from the directory
   * the manifest was installed from, so the /t/<token>/ prefix is
   * automatically re-appended to every player/catalog/library request.
   * Query strings on the manifest URL are NOT preserved by the client.
   *
   * encodeURIComponent keeps tokens with unusual characters URL-safe; the
   * Worker decodes each path segment before using it.
   */
  function buildAddonUrl(token) {
    var profile = parseInt(profileInput.value, 10) || 1;
    var url = WORKER_URL + "/t/" + encodeURIComponent(token) + "@" + profile;
    // /s/<stremioAuthKey> enables the Nuvio -> Stremio resume write-back.
    if (stremioKey) url += "/s/" + encodeURIComponent(stremioKey);
    return url + "/manifest.json";
  }

  // ---- Status helper ---------------------------------------------------------
  function setStatus(el, msg, kind) {
    el.innerHTML = msg;
    el.className = "status show " + (kind || "");
  }

  // ---- Sign in ---------------------------------------------------------------
  /**
   * Exchange the user's Nuvio credentials for an access token via the
   * Worker's /login endpoint:
   *
   *   POST <worker>/login  { email, password }
   *     -> Worker calls api.nuvio.tv/auth/v1/token?grant_type=password
   *     -> returns ONLY { access_token, expires_in, profiles }
   *
   * The password is used once and discarded by the Worker; nothing is
   * stored server-side. The returned token is kept in memory (never in
   * localStorage) and embedded only in the addon URL the user installs.
   */
  function signIn() {
    var worker = WORKER_URL;
    var email = emailInput.value.trim();
    var password = passwordInput.value;
    if (!WORKER_URL) { setStatus(signinStatus, "Worker URL not configured.", "err"); return; }
    if (!email || !password) { setStatus(signinStatus, "Enter your Nuvio email and password.", "err"); return; }

    savePrefs();
    signinBtn.disabled = true;
    setStatus(signinStatus, "Signing in&hellip;", "");
    passwordInput.value = ""; // never keep the password in the DOM

    fetch(worker + "/login", {
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
            ". Token is valid for " + Math.round((r.body.expires_in || 3600) / 60) + " minutes; " +
            "if syncing stops later, sign in again to refresh it.", "ok");
          signedInAs.style.display = "block";
          document.getElementById("stremioLink").style.display = "block";
        } else {
          setStatus(signinStatus, "Sign-in failed" + (r.body && r.body.error ? ": " + escapeHtml(r.body.error) : ""), "err");
        }
      })
      .catch(function () {
        setStatus(signinStatus, "Could not reach the Worker. Check the URL.", "err");
      })
      .then(function () { signinBtn.disabled = false; });
  }

  /**
   * Link the user's Stremio account via the Worker's /stremio-login endpoint:
   *   POST <worker>/stremio-login  { email, password }
   *     -> Worker calls api.strem.io/api/login, validates with getUser
   *     -> returns ONLY { authKey, user }
   *
   * The authKey is what lets the Worker write resume points into the user's
   * Stremio library (libraryItem.state.timeOffset). Password is cleared from
   * the DOM the moment it is sent; neither credential is stored.
   */
  function stremioSignIn() {
    var email = document.getElementById("stremioEmail").value.trim();
    var password = document.getElementById("stremioPassword").value;
    var statusEl = document.getElementById("stremioStatus");
    if (!email || !password) {
      setStatus(statusEl, "Enter your Stremio email and password.", "err");
      return;
    }
    setStatus(statusEl, "Linking Stremio&hellip;", "");
    document.getElementById("stremioPassword").value = "";

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
            " &mdash; Nuvio progress will resume inside Stremio.", "ok");
          document.getElementById("stremioSignin").style.display = "none";
          document.getElementById("skipStremio").style.display = "none";
        } else {
          setStatus(statusEl, "Stremio link failed" + (r.body && r.body.error ? ": " + escapeHtml(r.body.error) : ""), "err");
        }
      })
      .catch(function () {
        setStatus(statusEl, "Could not reach the Worker.", "err");
      });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ---- Advanced manual-token path --------------------------------------------
  function useManualToken() {
    var t = tokenInput.value.trim();
    if (!t) { setStatus(signinStatus, "Paste a token first.", "err"); return; }
    accessToken = t;
    setStatus(signinStatus, "Using the pasted token.", "ok");
    signedInAs.style.display = "block";
    document.getElementById("stremioLink").style.display = "block";
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

  // ---- Generate ---------------------------------------------------------------
  function generate() {
    if (!accessToken) {
      setStatus(signinStatus, "Sign in to Nuvio first.", "err");
      return;
    }
    var url = buildAddonUrl(accessToken);
    addonUrlInput.value = url;
    urlBox.classList.add("show");
    installCard.style.display = "block";
    renderQr(url);
  }

  // ---- Wiring -----------------------------------------------------------------
  signinBtn.addEventListener("click", signIn);
  // Enter in the password field submits.
  passwordInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") signIn();
  });
  useTokenBtn.addEventListener("click", useManualToken);
  resetBtn.addEventListener("click", function () {
    try { localStorage.removeItem(LS_KEY); } catch (e) {}
    emailInput.value = ""; passwordInput.value = ""; profileInput.value = "1";
    accessToken = null;
    signedInAs.style.display = "none";
    urlBox.classList.remove("show"); installCard.style.display = "none";
    setStatus(signinStatus, "Saved details cleared.", "");
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
  document.getElementById("stremioSignin").addEventListener("click", stremioSignIn);
  document.getElementById("stremioPassword").addEventListener("keydown", function (e) {
    if (e.key === "Enter") stremioSignIn();
  });
  document.getElementById("skipStremio").addEventListener("click", function () {
    document.getElementById("stremioLink").style.display = "none";
    setStatus(document.getElementById("stremioStatus"), "", "");
  });

  loadPrefs();
})();
</script>
</body>
</html>
`;
