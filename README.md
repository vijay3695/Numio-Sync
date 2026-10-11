# Stremio ↔ Nuvio Live Sync

A 100% free, **stateless, dbless** bridge that syncs live playback position and watched-state between **Stremio** and **Nuvio**.

Watch 30 minutes of a movie in Stremio, close the app — open Nuvio and it's in *Continue Watching* at exactly minute 30. Watch two episodes in Nuvio — open Stremio and the native *Continue Watching* resumes at the right position. Works on Android, Android TV, Firestick, iOS, and desktop.

- **No database.** No accounts, no tokens, no watch history is ever stored anywhere.
- **No servers to pay for.** Runs entirely on Cloudflare's free tier (100k requests/day, no card).
- **One addon link**, installed in both apps. That link *is* the login.
- **Bidirectional**, and independent of whether your client emits playback events.

---

## The problem it solves

Each app syncs beautifully with **itself** across devices — but nothing bridges *across* apps:

| Path | Native support |
|---|---|
| Stremio → Stremio | ✅ built in |
| Nuvio → Nuvio | ✅ built in |
| Stremio → Nuvio | ❌ only via Trakt/Simkl bridging, which is incomplete and often broken |
| Nuvio → Stremio | ❌ nothing |

Every existing answer falls short: Trakt/Simkl bridging misses titles, NuvioSync is a one-time migration, browser extensions don't cover TV/Firestick, and stream proxies can't detect an abrupt app exit.

---

## Architecture

```
                    ┌──────────────────────────────────────────────┐
                    │  Cloudflare Worker (free tier, stateless)     │
                    │                                              │
  Stremio  ────────►│  /manifest.json   addon identity + resources │
  (all platforms)   │  /catalog/...     Continue Watching + Watched│
                    │  /player/...      start/pause/stop + position│
  Nuvio   ────────►│  /library/...     watched marks               │
  (all platforms)   │  /login           Nuvio credential exchange  │
                    │  /stremio-login   Stremio account link       │
                    │  /debug           self-check page            │
                    │  /                the sign-in page           │
                    └───────────┬──────────────────────┬───────────┘
                                │                      │
                     Stremio account API        Nuvio account API
                     (library write-back)       (sync RPCs)
```

**The credential is the URL.** The generated link embeds the user's Nuvio token and (optionally) Stremio authKey in its path:

```
https://<worker>/t/<nuvioToken>@<profile>/s/<stremioAuthKey>/manifest.json
```

Stremio's HTTP transport derives every resource request from the directory the manifest was installed from, so the prefix is re-applied automatically to every request — the credential simply rides along. Nothing is stored; each request uses it for one API call and discards it.

### Why the path, not the query string

Query strings on the manifest URL are **not** preserved by clients. The path prefix is.

---

## How sync actually works

Both directions run automatically whenever **either app opens** (the manifest fetch), plus in real time on playback events:

| Direction | Source | Destination |
|---|---|---|
| **Stremio → Nuvio** | Read positions from the user's Stremio account (`libraryItem.state.timeOffset`) | `sync_push_watch_progress` |
| **Nuvio → Stremio** | `sync_pull_watch_progress` | Write library items with `state.timeOffset` — what Stremio's native Continue Watching reads to resume |

**Why not just wait for playback events?** The addon protocol *does* define a `player` event resource (start/pause/stop with `currentTime` and `duration`), and real-time pushes use it — but not every client build emits them. So the periodic read-from-account path carries the sync regardless, and the events make it instant when available.

**Conflict resolution** is timestamp-based and idempotent: writes carry the *source* timestamp, so a position synced once never bounces back and forth between apps.

**Watched state** (≥90% completion) is derived server-side by Nuvio; explicit watched marks are forwarded in both directions.

**Metadata** is deliberately *not* proxied. Titles and posters come from the user's own libraries (Nuvio library + Nuvio watch history + Stremio library), and the client's own installed meta addons resolve the rest. No third-party metadata requests, no API keys.

---

## Deploy

### 1. The Worker

```bash
npx wrangler login     # one-time browser auth
npx wrangler deploy    # prints your Worker URL
```

Or via the dashboard: *Workers & Pages → numio-sync → Edit code*, paste `worker.js`, **Deploy**.

Then set `WORKER_URL` at the top of `index.html` to your Worker URL, paste `index.html` into the `INDEX_HTML` block at the bottom of `worker.js`, and deploy again. (The page is served by the Worker itself — one host, one deploy, no GitHub Pages.)

Optional hardening (`wrangler.toml` → Variables): `ALLOWED_ORIGIN`, `PROFILE_ID`, `STREMIO_PROGRESS_TEMP`, `STREMIO_API`.

### 2. Use it

1. Open `https://<worker>/` → sign in to Nuvio → optionally link Stremio → **Generate add-on link**
2. Install the link in **Stremio** (Add-ons) and **Nuvio** (Settings → Content & Discovery → Addons). Nuvio TV: scan the QR code via *Manage from phone*.
3. Use the same profile number on both devices.
4. Open `…/debug` (the *Run sync self-check* button) to verify both connections and see what will sync next.

---

## Privacy

| Question | Answer |
|---|---|
| Is anything stored? | No. No database, no KV, no cookies, no sessions. |
| Are credentials logged? | No. The Worker never logs tokens, keys, passwords or emails. |
| Who can see my credentials? | Only the Worker, transiently, to make one API call on your behalf. Nobody else — unless you share your link. |
| Third-party requests? | None. The Worker only ever calls `api.nuvio.tv` and `api.strem.io`. |
| How do I revoke? | Uninstall the addon in both apps, or regenerate your tokens. |

The one trade-off of being dbless: the credential lives in the link itself. Treat the link like a password.

---

## Files

| File | Purpose |
|---|---|
| `worker.js` | The entire backend — addon protocol, both sync directions, sign-in endpoints, self-check page, and the embedded frontend (`INDEX_HTML` at the bottom). |
| `index.html` | The sign-in page. Copied verbatim into `worker.js`'s `INDEX_HTML` block (with `` ` `` and `${` escaped) when deploying. |
| `wrangler.toml` | Worker deploy config: name, entry, observability, variable documentation. |

---

## Development

`worker.js` is dependency-free ES modules. Tests run against the Worker locally with mocked Nuvio/Stremio APIs:

```bash
node test.mjs          # protocol, sync directions, security, self-check
```

Verify a live deployment:

```bash
npx wrangler tail      # real event log: [player], [auto-sync], [stremio], ...
```

or open `https://<worker>/t/<token>@1/s/<key>/debug` — the self-check page shows both connections, your Continue Watching counts, what will sync next, and recent events, with no terminal required.

---

## Known limits

- **Token lifetime.** Nuvio access tokens last about an hour. When one expires, sign in again and regenerate the link (30 seconds). Refresh tokens are single-use and rotating, which is why they can't be embedded statelessly.
- **Event support.** If your Stremio/Nuvio build doesn't emit `player` events, real-time pushes fall back to the manifest-triggered sync — slightly delayed, never lost.
- **Titles outside your libraries.** A title never added to any library and never watched to completion shows as `tt…` until your client's meta addons resolve it.
