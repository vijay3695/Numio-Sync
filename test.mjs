/**
 * Test suite for worker.js - runs the Worker locally with mocked Nuvio and
 * Stremio APIs. No dependencies, no network.
 *
 *   node test.mjs
 *
 * Covers: the addon protocol routes, both sync directions, idempotence,
 * conflict resolution, metadata sources, sign-in endpoints, the self-check
 * page, security headers and the origin guard.
 */

const workerPath = new URL('./worker.js', import.meta.url).href;
const { default: worker } = await import(workerPath);

// ---------------------------------------------------------------------------
// Mock accounts (simulating the user's Nuvio + Stremio account state)
// ---------------------------------------------------------------------------
const NOW = Date.now();
let nuvioStore = [
  // watched in Nuvio just now, ahead of the Stremio copy
  { content_id: 'tt0468569', content_type: 'movie', video_id: 'tt0468569', position: 2400000, duration: 8400000, last_watched: NOW },
];
let stremioStore = [
  // watched in Stremio yesterday at 1:40, behind Nuvio
  { _id: 'tt0468569', name: 'The Dark Knight', type: 'movie', poster: 'https://img/dk.jpg', temp: false, removed: false, _ctime: '2020-01-01T00:00:00Z', state: { timeOffset: 100000, duration: 8400000, lastWatched: new Date(NOW - 86400000).toISOString(), watched: null, timesWatched: 1 } },
  // watched in Stremio, missing from Nuvio entirely
  { _id: 'tt0111161', name: 'Shawshank', type: 'movie', poster: null, temp: false, removed: false, _ctime: '2020-01-01T00:00:00Z', state: { timeOffset: 3600000, duration: 9000000, lastWatched: new Date(NOW - 3600000).toISOString(), watched: null, timesWatched: 1 } },
];

const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ url: u, body, origin: (opts.headers && opts.headers.Origin) || null });

  // ---- Stremio account API ----
  if (u.includes('api.strem.io')) {
    if (u.endsWith('/login')) {
      return body.email === 'u@s.com' && body.password === 'pw'
        ? Response.json({ result: { authKey: 'SKEY', user: { _id: 'u1', email: 'u@s.com' } } })
        : Response.json({ error: { code: 400, message: 'Invalid login' } }, { status: 400 });
    }
    if (u.endsWith('/getUser')) return Response.json({ result: { _id: 'u1', email: 'u@s.com' } });
    if (u.includes('datastoreGet')) {
      const res = body.all
        ? stremioStore.map((x) => ({ ...x }))
        : (body.ids || []).map((id) => stremioStore.find((x) => x._id === id)).filter(Boolean).map((x) => ({ ...x }));
      return Response.json({ result: res });
    }
    if (u.includes('datastorePut')) {
      body.changes.forEach((ch) => {
        stremioStore = stremioStore.filter((x) => x._id !== ch._id).concat({ ...ch });
      });
      return Response.json({ result: { success: true } });
    }
    return Response.json({ result: { success: true } });
  }

  // ---- Nuvio API ----
  if (u.includes('/auth/v1/token')) return Response.json({ access_token: 'AT', expires_in: 3600 });
  if (u.includes('sync_pull_watch_progress')) return Response.json(nuvioStore.map((r) => ({ ...r })));
  if (u.includes('sync_pull_watched_items')) {
    return Response.json([{ content_id: 'tt0999999', content_type: 'movie', title: 'From History' }]);
  }
  if (u.includes('sync_pull_library')) return Response.json([]);
  if (u.includes('sync_pull_profiles')) return Response.json([{ name: 'Main', profile_index: 1 }]);
  if (u.includes('sync_push_watch_progress')) {
    const e = body.p_entries[0];
    nuvioStore = nuvioStore
      .filter((r) => r.content_id !== e.content_id)
      .concat({ content_id: e.content_id, content_type: e.content_type, video_id: e.video_id, position: e.position, duration: e.duration, last_watched: e.last_watched });
    return new Response(null, { status: 204 });
  }
  if (u.includes('sync_push_watched_items')) return new Response(null, { status: 204 });
  return new Response('nf', { status: 404 });
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
const ctxObj = { jobs: [], waitUntil(p) { p.catch(() => {}); this.jobs.push(p); } };
const BASE = 'https://numio-sync.example.workers.dev';
const req = (p, o) => new Request(BASE + p, {
  method: (o && o.method) || 'GET',
  headers: Object.assign({ 'Content-Type': 'application/json' }, (o && o.headers) || {}),
  body: o && o.body,
});
const get = (p) => worker.fetch(req(p), {}, ctxObj);
const post = (p, b, h) => worker.fetch(req(p, { method: 'POST', body: JSON.stringify(b), headers: h || {} }), {}, ctxObj);
const settle = () => new Promise((r) => setTimeout(r, 60));

let pass = 0, fail = 0;
const t = (name, cond) => { cond ? pass++ : (fail++, console.log('FAIL:', name)); };
const stDk = () => stremioStore.find((x) => x._id === 'tt0468569');
const nvShaw = () => nuvioStore.find((r) => r.content_id === 'tt0111161');

// ---------------------------------------------------------------------------
// A. Security
// ---------------------------------------------------------------------------
let r = await get('/');
let html = await r.text();
let csp = r.headers.get('Content-Security-Policy');
t('page served at /', html.includes('Sign in to Nuvio'));
t('CSP: nonce-based scripts, no unsafe-inline', /script-src 'nonce-[a-f0-9]+'/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp));
t('CSP: connect-src self only', csp.includes("connect-src 'self'"));
t('security: nosniff / frame-options / no-referrer',
  r.headers.get('X-Content-Type-Options') === 'nosniff' &&
  r.headers.get('X-Frame-Options') === 'DENY' &&
  r.headers.get('Referrer-Policy') === 'no-referrer');
const nonces = [...html.matchAll(/<script nonce="([a-f0-9]+)"/g)].map((m) => m[1]);
t('every script tag carries exactly one matching nonce',
  nonces.length === 2 && nonces.every((n) => csp.includes(`nonce-${n}`)) &&
  [...html.matchAll(/<script[^>]*>/g)].every((m) => (m[0].match(/nonce=/g) || []).length === 1));

r = await post('/login', {}, { Origin: 'https://evil.example.com' });
t('sign-in: third-party origin blocked', r.status === 403);
r = await post('/login', {}, {});
t('sign-in: works with no Origin header (Firefox/WebView)', r.status === 400);
r = await post('/stremio-login', {}, {});
t('stremio-login: works with no Origin header', r.status === 400);
r = await post('/stremio-login', { email: 'u@s.com', password: 'pw' });
t('stremio-login: returns only the authKey', (await r.json()).authKey === 'SKEY');
r = await post('/login', { email: 'u@n.com', password: 'pw' });
t('nuvio login: returns a token + profiles', (await r.json()).ok === true);

// ---------------------------------------------------------------------------
// B. Manifest
// ---------------------------------------------------------------------------
const m = await (await get('/t/T/manifest.json')).json();
t('manifest: catalog/stream/player/library, no meta', m.resources.map((x) => x.name).join(',') === 'catalog,stream,player,library');
t('manifest: 4 catalog rows', m.catalogs.length === 4);

// ---------------------------------------------------------------------------
// C. Bidirectional sync via the manifest request alone
// ---------------------------------------------------------------------------
await get('/t/NT@1/s/SKEY/manifest.json');
await settle();
t('Nuvio -> Stremio: resume point written', stDk().state.timeOffset === 2400000);
t('Nuvio -> Stremio: real title/poster preserved', stDk().name === 'The Dark Knight' && stDk().poster === 'https://img/dk.jpg');
t('Nuvio -> Stremio: written as a library item (not temp)', stDk().temp === false && stDk().removed === false);
t('Nuvio -> Stremio: source timestamp carried over', stDk().state.lastWatched === new Date(NOW).toISOString());
t('Stremio -> Nuvio: title missing in Nuvio gets pushed', !!nvShaw() && nvShaw().position === 3600000 && nvShaw().duration === 9000000);
t('Stremio -> Nuvio: Stremio timestamp carried over', !!nvShaw() && nvShaw().last_watched === NOW - 3600000);

const norm = () => JSON.stringify({
  n: [...nuvioStore].sort((a, b) => a.content_id.localeCompare(b.content_id)),
  s: [...stremioStore].sort((a, b) => a._id.localeCompare(b._id)).map((x) => [x._id, x.state.timeOffset, x.state.lastWatched]),
});
const before = norm();
await get('/t/NT@1/s/SKEY/manifest.json');
await settle();
t('idempotent: a second cycle changes nothing (no ping-pong)', norm() === before);

// fresh playback on each side, with NO player events involved
stremioStore = stremioStore.map((x) => x._id === 'tt0111161'
  ? { ...x, state: { ...x.state, timeOffset: 7000000, lastWatched: new Date(NOW + 60000).toISOString() } }
  : x);
await get('/t/NT@1/s/SKEY/manifest.json');
await settle();
t('new Stremio position reaches Nuvio without any player event', nvShaw().position === 7000000 && nvShaw().last_watched === NOW + 60000);

nuvioStore = nuvioStore.map((r2) => r2.content_id === 'tt0468569' ? { ...r2, position: 8000000, last_watched: NOW + 120000 } : r2);
await get('/t/NT@1/s/SKEY/manifest.json');
await settle();
t('new Nuvio position reaches Stremio', stDk().state.timeOffset === 8000000);

// ---------------------------------------------------------------------------
// D. Metadata comes from the user's own data
// ---------------------------------------------------------------------------
r = await get('/t/NT@1/s/SKEY/catalog/movie/nuviowatched.json');
const wb = await r.json();
t('watched row titled from Nuvio watch history', wb.metas.some((x) => x.id === 'tt0999999' && x.name === 'From History'));

// ---------------------------------------------------------------------------
// E. Real-time event path
// ---------------------------------------------------------------------------
await get('/t/NT@1/s/SKEY/player/series/tt0903747:1:1/action=stop&currentTime=3312000&duration=3480000.json');
await settle();
t('player event: position pushed to Nuvio', calls.some((x) => x.url.includes('sync_push_watch_progress') && x.body.p_entries.some((e) => e.season === 1 && e.episode === 1 && e.position === 3312000)));
t('player event: mirrored into the Stremio account', calls.filter((x) => x.url.endsWith('/datastorePut')).length >= 2);
r = await get('/t/NT@1/s/SKEY/library/movie/tt1/action=watched.json');
t('library event: watched mark accepted', r.status === 200);

// ---------------------------------------------------------------------------
// F. Self-check page
// ---------------------------------------------------------------------------
r = await get('/t/NT@1/s/SKEY/debug');
const dh = await r.text();
t('self-check: reports both connections and activity', dh.includes('Nuvio token') && dh.includes('Stremio account') && dh.includes('Recent events') && dh.includes('push-nuvio'));
t('self-check: leaks no secrets', !dh.includes('SKEY') && !dh.includes('access_token'));

// ---------------------------------------------------------------------------
// G. Regressions
// ---------------------------------------------------------------------------
r = await get('/t/T/health');
t('health endpoint', (await r.json()).ok === true);
r = await get('/t/T/stream/movie/tt1.json');
t('stream endpoint returns an empty list (heartbeat only)', (await r.json()).streams.length === 0);
r = await get('/t/T/catalog/movie/nuviocw.json');
t('unlinked install still serves its rows', r.status === 200);
r = await worker.fetch(req('/t/X/manifest.json', { method: 'OPTIONS' }), {}, {});
t('CORS preflight on every route', r.status === 204 && r.headers.get('Access-Control-Allow-Origin') === '*');
r = await get('/player/movie/tt1/action=pause&currentTime=1&duration=2.json');
t('missing token rejected on protected routes', r.status === 400);
r = await get('/t/T/unknown.json');
t('unknown route -> 404', r.status === 404);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
