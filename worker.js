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

/** Cinemeta: used to decorate the Continue Watching catalog with posters. */
const CINEMETA_DEFAULT = 'https://v3-cinemeta.strem.fun';

/** Profile used when the install URL does not carry `@<profile>`. */
const DEFAULT_PROFILE_ID = 1;

/** Max rows returned by the Continue Watching catalog. */
const CATALOG_LIMIT = 40;

/**
 * Per-isolate in-memory cache for Cinemeta metadata lookups.
 * Purely an optimization; a cold isolate simply refetches.
 */
const metaCache = new Map(); // key -> { expires, value }
const META_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// SMALL HELPERS
// ---------------------------------------------------------------------------

/** CORS is mandatory: "each route, including /manifest.json, must serve
 *  CORS headers that allow all origins" - Stremio protocol doc. */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Allow-Headers': '*',
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
    cinemeta: (env.CINEMETA || CINEMETA_DEFAULT).replace(/\/+$/, ''),
    defaultProfileId: toInt(env.PROFILE_ID, DEFAULT_PROFILE_ID) || DEFAULT_PROFILE_ID,
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
async function handlePlayerEvent(type, videoId, extraSegment, cfg, token, profileId) {
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

  // ---- 4. Fire it at Nuvio immediately ----
  try {
    await pushProgress(cfg, token, profileId, entry);
    const pct = Math.round((currentTime / duration) * 100);
    console.log(`[player] pushed ${entry.content_id} at ${pct}% to Nuvio profile ${profileId}`);
  } catch (err) {
    // Never break playback because of a sync failure.
    console.error(`[player] push failed: ${err.message}`);
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
async function handleCatalog(type, catalogId, cfg, token, profileId) {
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

    const meta = await fetchCinemetaMeta(cfg, wantedType, row.content_id);
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

  return json({ metas: metas.slice(0, CATALOG_LIMIT) });
}

/** Cinemeta lookup with a short per-isolate cache (decorates posters only). */
async function fetchCinemetaMeta(cfg, type, id) {
  const key = `${type}:${id}`;
  const hit = metaCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  try {
    const res = await fetch(`${cfg.cinemeta}/meta/${type}/${id}.json`, {
      headers: { 'User-Agent': 'stremio-nuvio-sync/1.0' },
    });
    if (!res.ok) {
      metaCache.set(key, { expires: Date.now() + 60_000, value: null });
      return null;
    }
    const data = await res.json();
    const meta = data && data.meta ? data.meta : null;
    metaCache.set(key, { expires: Date.now() + META_TTL_MS, value: meta });
    return meta;
  } catch {
    return null;
  }
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

    try {
      const segments = url.pathname.split('/').filter(Boolean).map(safeDecode);

      // ---- Resolve optional /t/<token>@<profile> prefix ----------------
      let idx = 0;
      let token = null;
      let profileId = cfg.defaultProfileId;

      if (segments[0] === 't' && segments[1]) {
        const parsed = parseTokenSegment(segments[1]);
        token = parsed.token || null;
        if (parsed.profileId && parsed.profileId >= 1 && parsed.profileId <= 6) {
          profileId = parsed.profileId;
        }
        idx = 2;
      }

      // Fallback: token may arrive as ?nuvioToken= on the manifest URL.
      if (!token) token = url.searchParams.get('nuvioToken');

      const rest = segments.slice(idx);
      const head = rest[0];

      // ---- manifest ------------------------------------------------------
      if (!head || head === 'manifest.json' || head.startsWith('manifest.json?')) {
        return json(buildManifest());
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
        return await handleCatalog(type, catalogId, cfg, token, profileId);
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
        return await handlePlayerEvent(type, videoId, extra, cfg, token, profileId);
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
