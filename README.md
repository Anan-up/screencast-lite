[English](README.md) | [简体中文](README_Simplified_Chinese.md) | [繁體中文](README_Classical_Chinese.md)

# Screencast Lite

Cast one web page's screen to another web page in real time. **Pure white minimalist style**, LAN P2P direct connection preferred, with automatic fallback to server relay when direct connection fails.

## Quick Start

```bash
cd screencast
npm install          # runtime dependency is just ws (WebSocket server)
node server/server.js
```

> **Using pnpm?** The `pnpm-lock.yaml` in the repo locks both the runtime dependency `ws` and the dev dependency `puppeteer-core` (the latter is used by browser test cases and is not required), so both `pnpm install --frozen-lockfile` and `pnpm install` work directly. If you only want runtime dependencies and want to skip `puppeteer-core`, use `pnpm install --prod`.
>
> **Using npm?** Simply ignore `pnpm-lock.yaml`: `npm install` only installs `ws` from `dependencies`; `npm i -D puppeteer-core` installs the browser driver used for testing.

After startup, the terminal prints the available addresses:

```
Local console   http://localhost:8080/cast
Local display   http://localhost:8080/view
LAN display     http://192.168.x.x:8080/view
```

**Usage**: On the computer you want to cast, open `/cast` → click "Select screen and start casting" → on the display device open `/view` → enter the 4-digit room code (or scan the QR code directly).

## Tech Stack

| Layer | Solution |
|---|---|
| Screen capture | `getDisplayMedia()` — entire screen / single window / browser tab |
| Peer-to-peer transport | **WebRTC** `RTCPeerConnection` — direct connection within LAN, lowest latency |
| Signaling channel | **WebSocket** — room code pairing, SDP/ICE exchange, automatic reconnect on disconnect |
| NAT traversal | **STUN** (Google / Cloudflare public nodes) + optional **TURN** |
| Automatic routing | P2P direct connection preferred → fallback to **server relay** when direct connection fails |

## Dual-Mode Link

```
                         ┌─ LAN P2P direct (preferred, lowest latency)
Sender ──── negotiate ───┤
                         └─ Server relay (automatic fallback when P2P fails)
```

### Direct Mode (default)

Both endpoints on the same LAN transmit video streams directly peer-to-peer, without going through the server. The sender page shows "**P2P Direct**" or "**LAN Direct**".

### Relay Mode (automatic fallback)

It automatically switches to relay in three cases, **no manual action needed**:

1. **P2P negotiation timeout** — not connected within 6.5 seconds
2. **ICE negotiation failure** — `connectionState` becomes `failed` (switches immediately, no waiting)
3. **Silent picture interruption** — connection looks normal but no frames are being produced (key fallback, see below)

When `connectionState` becomes `disconnected`, it does **not** degrade immediately — it is a recoverable transient state, given a 3-second grace period; if it recovers within that period it stays on P2P. Only if it is still `disconnected` after 3 seconds does it switch to relay.

In relay mode, the sender uses `MediaRecorder` to encode the screen into WebM segments, forwards them through WebSocket binary frames via the server, and the receiver uses `MediaSource` to play while receiving (auto frame-chasing to reduce latency).

> **Relay-mode HUD**: This link has no `RTCPeerConnection`, so `getStats()` returns nothing. Resolution and frame rate are therefore collected locally from the `<video>` element (`videoWidth/videoHeight`, `getVideoPlaybackQuality().totalVideoFrames` difference); **RTT is unobservable and always shows "—"** — a relay simply has no measurable link round-trip time, so this is an honest result, not a missing feature.

> **Multi-screen shared encoder**: No matter how many displays are connected, relay uses only **one** `MediaRecorder`. Segments are routed to the corresponding display on the server via an 8-byte `viewerId` prefix — even 8 screens run only one VP8/VP9 encoder, so you won't see 8 encoders burning CPU simultaneously.

### Disconnect Behavior Between Display and Sender

Two paths, depending on whether the host "**temporarily left**" or "**really ended**".

**Path A: Temporary leave (page refresh / signaling jitter) — graceful reconnect**

Before disconnecting, the sender sends a `host-away`, based on which the server **does not immediately destroy the room**, entering a 15-second grace window:

```
Sender ws disconnects
   │
   ├─ has host-away flag → room kept for 15s, display banner "Sender connection unstable, recovering…"
   │      ├─ host reconnects with same code within window → broadcast host-return → display "Recovered", seamless resume
   │      └─ still not back after timeout → destroyRoom('host reconnect timeout') → display returns to standby
   │
   └─ no flag (cable pulled, network switch, etc. — no time to notify) → destroyRoom immediately → display returns to standby and auto-retries
```

**Key point**: Room retained ≠ connection still alive. After the host reloads, the old `RTCPeerConnection` is dead, but its `connectionState` may stay at `connected` for a long time (after the peer disappears, ICE takes tens of seconds to judge failure). At this point `vx.mode` still shows `p2p-host` and looks fine, but `video.currentTime` has long frozen.

So when the display decides "whether to rebuild", it **routes by signal strength** instead of a one-size-fits-all rule:

| Trigger signal | Strength | Handling |
|---|---|---|
| `host-return` | **Strong** (host explicitly says it just did `create(reused)`, old pc is definitely dead) | `scheduleRejoin(true)` — zero delay, **unconditional** rebuild, no health check |
| Already in `relay` / `relay-blob` | **Reverse signal** (host actively switched over) | Directly cancel, **never** rebuild P2P |
| `connectionState → failed` | Weak (could be transient jitter) | `scheduleRejoin(false)` — backoff delay, then re-confirm with `isPictureAlive()` |

**Why relay mode must be intercepted separately**: Switching to relay is an active decision on the host side (`pc failed → enableRelay → relay-begin`). If the display rebuilds P2P at this point, the host would `removeViewer → clear relayViewers → sharedRecorder.stop()`, **tearing down** the freshly built relay link; then the new pc likely fails again, switches to relay again, sends `relay-begin` again — both sides fall into an oscillation of "switch to relay → display rebuilds P2P → fails again → switch to relay again", and the user sees the picture interrupted every few tens of seconds.

This check must be placed at the **caller** (`scheduleRejoin`), not inside `isPictureAlive()`. The latter's semantics is "is the P2P picture moving", and in relay mode the picture is of course moving (the data source just isn't WebRTC). Having it return `false` would be lying, and the caller would tear down the relay link based on it — a classic case of **semantic pollution**.

On the `host-return` path, `isPictureAlive()` must **never** be called either: its first call has no baseline and takes the "optimistically return true" branch (to avoid misjudging a freshly established connection as stalled), which would exactly return-cancel the rebuild — and `host-return` is precisely the cold-start scenario where the baseline has never been established. The result would be a **permanently frozen picture**.

`isPictureAlive()` returning `true` has two meanings, and the caller must distinguish them:

- **Has baseline and `currentTime` is increasing** → genuinely healthy, cancel this action and wait for the next round;
- **First sample / over 30 seconds since last, no baseline** → just an optimistic "cannot judge" value, does **not** mean confirmed healthy, still cancel.

The `false` criteria also have two thresholds — don't get them wrong when writing tests (both are inside `isPictureAlive`):

| Condition | Conclusion |
|---|---|
| `now - lastVideoAt > 30000` | Classified as "no baseline" → optimistically return `true` |
| `now - lastVideoAt >= 6000` | Confirmed stalled (`moving = false`) |

**Cancel ≠ give up: must reschedule.** Both cancellation cases must fully roll back (`rejoinAttempts` decremented, `rejoinInFlight` cleared), **then immediately `scheduleRejoin(false)` to schedule the next round**:

- Not clearing `rejoinInFlight` → leaves a fake "rebuild in progress" state, and any subsequent `join-failed` will hit `if (rejoinInFlight) → scheduleRejoin(true)` and be silently upgraded to a forced rebuild, bypassing the "should we rebuild" decision;
- Not rescheduling → **the `failed` event only fires once when `connectionState` changes**, so after cancellation there is no second trigger source (`host-return` requires host reconnect, `join-failed` requires a join to be initiated first, and no join means no `join-failed`) — the picture would **freeze permanently until the user manually refreshes**. The next round of sampling already has a baseline, so if the picture is truly dead it returns `false` and rebuild proceeds normally.

Rate limiting uses two **independent** counters with different semantics — don't mix them:

| Counter | Meaning | Limit |
|---|---|---|
| `rejoinAttempts` | Times a rebuild was **actually initiated** (perturbs host-side peer/relay state) | `REJOIN_MAX = 12` |
| `rejoinChecks` | Times a decision was **cancelled** (zero-cost local check, prevents misjudgment loops) | `REJOIN_CHECKS_MAX = 20` |

The forced path (`host-return`) does **not** count toward `REJOIN_MAX`: it has `delay=0`; if it counted, the 12 attempts would be exhausted almost instantly while the host is still reloading, triggering `onHostGone` early and kicking the display back to standby. Its rate limiting is handled by the `join-failed → backoff retry` chain itself — that branch calls `scheduleRejoin(false)` (starting at 1200ms, linear growth, counts toward `REJOIN_MAX`). **Historically this mistakenly used `scheduleRejoin(true)`**: `delay=0` meant a join-failed would immediately re-join on the next tick, forming a flood throttled only by network RTT (locally measured ~30,000 joins in 4 seconds), while consuming no quota at all. Regression evidence is in `test/join-failed-backoff.js`.

When the display rebuilds, the server **reuses the original viewerId** (rather than assigning a new one); otherwise the host would treat the same device as a new device via `addViewer`, and the old peer would never be reclaimed — the ghost display would reappear. Likewise, after the host's `create(reused)` succeeds, the server **re-sends the current list of viewers in the room** (`viewer-joined` with `rejoined: true`), ensuring that in the "display joins first, host creates later" race the host also knows a display is waiting.

> **Known redundancy (deliberately kept)**: During graceful reconnect, the same display may trigger **two** offer round-trips.
>
> There are two trigger chains, both pointing to the same display:
>
> | Source | Path |
> |---|---|
> | Server resend | `created(reused)` → server broadcasts `viewer-joined` → host `addViewer` → sends offer |
> | Display-driven | `host-return` → display `resetRejoin()` + `scheduleRejoin(true)` → `doJoin` → server sends `viewer-joined` again → host sends offer **again** |
>
> When the host receives the second `viewer-joined`, it goes through `addViewer`, whose beginning has `if (peers.has(viewerId)) removeViewer(viewerId)`, which tears down the just-built first `RTCPeerConnection` and rebuilds (same `viewerId`, so no ghost peer — just one wasted PC construction + offer/answer). The cost is ~1 second slower reconnect, **no error introduced**.
>
> Why not fix it: these two chains are mutual **insurance**. Keeping only the server resend means that if the resend logic fails (e.g., under some race the display isn't yet in `room.viewers`), the host wouldn't know anyone is waiting and the picture would stay black forever; keeping only the display-driven path means the host must first wait for the display to discover it (depending on `host-return` arriving). Keeping both means either one working is enough to recover. Adding a "have I already sent an offer" dedup flag would introduce new state dependency into this recovery path, with more risk than the 1-second benefit — so **keep as-is and document it**.

**Cross-room switching**: When a viewer `join`s **another** room code, the server first cleans up references to the old room (`viewers.delete` + notify old host `viewer-left` + reset `viewerId`). Without cleanup, the old room's `viewers.size` never decreases (slot permanently occupied), the old host keeps sending `offer` / `viewer-status` to this ws, and the display answers as usual → **one ws hangs in two rooms' P2P simultaneously**.

**About `replaced` (unreachable under current protocol, kept as defense)**: The server's `create` branch has two checks on host `readyState`, which are exactly mutually exclusive for the **same host**:

| Check | Condition | Effect |
|---|---|---|
| `reusable` | `existing.host.readyState !== OPEN` | Only **then** allow reusing the requested room code |
| `replaced` branch | `room.host.readyState === OPEN` | Only **then** treat old host as forcibly taken over, send `replaced` and `close()` |

If the old host is alive (`OPEN`) → `reusable` is false → `genCode()` changes the code → the new room is empty, the `replaced` branch's first condition is false; if the old host is dead → `reusable` is true → the dead ws in `room.host` doesn't satisfy `=== OPEN` → the `replaced` branch is still false. **The two can never both be true**, measured across 5 timing scenarios (alive / `host-away` / half-open `pause` / half-open + `terminate` / `leave`) with a hit rate of **0/5**.

That is, the `role = 'replaced'` assignment, the `replaced` notification, and the two `if (ws.role === 'replaced') return` in `handleSignal` / binary branch are **all defensive dead code**. Reasons to keep them:

1. **Self-documenting intent**: readers don't have to derive "why changing `role` isn't enough" themselves. If you only change `role` and delete the guard, the moment someone relaxes "allow force takeover of same-code room", the old connection would immediately fall into `handleSignal`'s `else` (viewer) branch and forward signaling with `viewerId: undefined` to the new host — the guard must **already** be there at that moment.
2. **Semantic anchor for future extension**: force takeover ("I want to kick someone else off this room code") is a reasonable requirement, and then `replaced` would immediately become a hot path.
3. **Zero cost**: both checks are at message entry, no IO, no state.

**The sender (`cast.html`) `replaced` handler is deliberately minimal** — only set a flag + show a toast + call `reconnectNow()`, **without** local state cleanup:

```js
signal.on('replaced', () => {
  // Set "this disconnect was caused by room takeover" so the subsequent
  // close / reconnecting handlers show the correct text instead of the
  // misleading "connection interrupted".
  replacedRecently = true;
  clearTimeout(replacedFlagTimer);
  replacedFlagTimer = setTimeout(() => { replacedRecently = false; }, 3000);
  toast('This room was recreated elsewhere, reconnecting…');
  try { signal.reconnectNow(); } catch {}
});
```

Three reasons:

- **No duplicate cleanup**: `reconnectNow()` immediately triggers `onclose` → the `signal.on('close')` handler, and the responsibility for clearing `roomCode` / `viewerMap` / `host.peers` **uniquely** belongs there. Cleaning again in this handler would be "cleaning the same state twice" — today each operation happens to be idempotent so nothing breaks, but as soon as the `close` handler adds any non-idempotent action (e.g., resending a signal), it would become duplicated execution.
- **Never use `close()`**: earlier versions wrote `signal.close()` here, which sets `closedByUser = true` and makes the signaling layer **permanently disconnected**, kicking the user offline with no recovery — worse than "doing nothing". See the `close()` / `reconnectNow()` comparison table in the previous section.
- **Calling `setLink` here is ineffective**: `reconnectNow()` synchronously triggers `onclose` → `close` handler, where `setLink` would immediately overwrite the text just set here — pointless. So the text is **not** set in this handler; instead the `replacedRecently` flag lets the `close` / `reconnecting` handlers choose the right wording.

> **Why must the flag outlive the `close` handler?** In `onclose`, after `emit('close')`, `emit('reconnecting')` follows **within the same synchronous tick**. If the flag were cleared in the `close` handler, the immediately-following `reconnecting` handler would show the neutral "reconnecting (1)", overwriting "room taken over" — the user would never even see it (a `MutationObserver` can't observe that intermediate value either). So the flag is **not** cleared in `close`; it lives until `open` (reconnect success = context over) and is then cleared; plus a 3-second auto-expiry fallback to prevent "residual flag on an abnormal path being mis-consumed as a false takeover notice on a later unrelated disconnect".

The corresponding regression tests are provided with the project (`test/` directory). **A single command runs all cases**:

```bash
npm test          # internally test/run-all.js starts the server → runs cases → cleans up
```

`test/run-all.js`'s port strategy: if `8080` is already occupied (e.g., you're running `npm start`), it **directly reuses** the existing service; if free, it starts its own temporary service and kills it when done. So whether or not you have a service running, `npm test` runs directly — no "forgot to start the server → all ECONNREFUSED".

| File | Form | Proves what |
|---|---|---|
| `test/replaced-guard.js` | Protocol-layer black box (real ws connecting to server) | **Control group**: a connection joining as viewer — its `offer` / binary frames **are indeed** forwarded to host — this is exactly the root cause of "non-host connections fall into the `else` branch"; **invariant**: a new ws gets a new code when the same code is occupied (evidence that no takeover happens when a live host occupies the code) |
| `test/replaced-guard-race.js` | Protocol-layer black box + local white-box replica | **Invariant**: under observable timing, old host never receives `replaced` (S5, unobservable after `terminate()`, records `hit=null` and is **excluded from assertions**, not faked as evidence); **A/B**: removing the guard from the "locally-replicated forwarder" leaks 5 messages immediately (including malformed `viewerId: undefined`), reinstalling the guard blocks all |
| `test/reconnect.js` | Browser (puppeteer) | **P0**: 11s after `close()` still CLOSED (never reconnects); returns to OPEN after `reconnectNow()`; `close()`'s permanent-close semantics not harmed |
| `test/reconnect-closing.js` | Browser (puppeteer) | **P1**: `close()` + `reconnectNow()` within the same tick **deterministically hits the CLOSING window**, verifying no orphan connection (reverting the fix observes `openNow=2`, two ws OPEN simultaneously) |
| `test/replaced-ux.js` | Browser (puppeteer, hijacks `textContent` setter) | **UX**: after room takeover the link text should be `房间被接管，正在重连` → `…(n)` → `服务已连接`, and must **not** show a bare "connection interrupted" in between (would be misread as a network fault); normal disconnects still show "connection interrupted" (flag doesn't linger and false-report) |
| `test/quality-injection.js` | Browser (puppeteer, canvas pseudo-stream) | **Regression**: a newly-joined display's `maxBitrate/maxFramerate` must equal the **current** user selection (three tiers verify 1.5M / 4M / 15M). Reverting the fix collapses all three tiers back to 4M/30 (3/7) — proves it catches the "hardcoded" defect |
| `test/newcode-cleanup.js` | Browser (puppeteer, `__forceStarted` hook) | **Regression**: after clicking "new code", the transport layer's `peers` must be empty and `stats.total` zeroed. Reverting the fix leaves 3 entries (4/6) — exactly the "UI zeroed but transport layer not zeroed" decoupling defect |
| `test/viewer-teardown.js` | Browser (puppeteer, real host+viewer two pages) | **Regression**: after host ends casting (`room-closed`), receiver's `vx.mode` resets to `connecting`, and the **old pc instance**'s `connectionState === 'closed'` (assertion directly watches `window.__oldPc`, not the empty assertion "new vx's pc is null"). Reverting the fix leaves mode at `p2p-host`, old pc still `connected` |
| `test/concurrent-addviewer.js` | Browser (puppeteer, hijacks `RTCPeerConnection.createOffer` to gate) | **P0 regression**: concurrent `addViewer` (same viewerId sent twice in a row, which **always** happens on the graceful-reconnect path) — the first's abandoned link must not mistakenly switch the second's healthy connection to relay. The case uses a "first createOffer never resolves" gate to **deterministically** create concurrency, not betting on timing. Reverting the fix changes `mode` to `relay`, new-generation pc mistakenly closed (3/5) — precisely reproduces the reported T2–T3 sequence |
| `test/answer-seq.js` | Browser (puppeteer, white-box `__host.onAnswer` + hijack `setRemoteDescription` counter) | **P0 regression**: under graceful reconnect's double offer round-trip, the old-generation offer's answer may arrive late and be applied to the **new-generation pc** (`have-local-offer`→`stable`, then the real answer throws `InvalidStateError`, link permanently stuck negotiating). Fix correlates offer/answer by **generation number**: `addViewer` assigns `seq` to entry, offer carries seq, answer echoes seq, `onAnswer` rejects stale answers where `entry.seq !== seq`. **A/B**: removing seq validation → 2/4 (stale answer penetrates, `setRemoteDescription` called) |
| `test/viewer-status-id.js` | Protocol-layer black box (real host+viewer ws) | **Security regression**: when forwarding `viewer-status`, `viewerId` **and `type`** must both be determined by the server, **not** overwritten by same-named fields in `msg.payload`. viewerId forgery can pollute **another** display's liveness (via the watchdog irreversibly switching others to relay); type forgery can disguise message types (`replaced`→force host reconnect DoS, `viewer-left`→kick people, `host-away`→advance grace window). **A/B**: putting `type` back before payload → 7/9 (host receives `{"type":"replaced",…}`, two assertions turn red) |
| `test/static-hygiene.js` | Static scan (no browser dependency, always runnable) | **Hygiene**: scans destructuring declarations across 6 files, reports variables "destructured but never used"; includes a **reverse self-check** (synthetic samples must be reported, proving "zero findings" isn't a broken detector), contract assertions for the two historical issues `const { fps }` / `const { vt, at }`, and **`test/*.js` must not hardcode absolute node_modules paths** (a case once required an absolute path under `/tmp`; in an environment without that directory it was swallowed by try/catch and exit(0), and run-all only checks exit code → the only case covering the P0 flood defect silently SKIPped yet reported "pass") |
| `test/crossroom.js` | Protocol-layer black box (three real ws: host A / host B / viewer) | **Regression**: when the same viewer ws switches from room A to B, old room references must be fully cleaned — old host receives `viewer-left`, `viewerId` is reassigned (reusing would make old host's `removeViewer` mistakenly hit the new room's peer), and on close only B receives notification. Reverting the fix: old host doesn't receive `viewer-left` (9/10) |
| `test/stale-cond.js` | Browser (puppeteer, `__rejoin.forceStale*` hooks) | **White-box**: `forceStale` requires `withinWindow` and `advanced` **both** false to judge "frozen"; `forceStaleDrift()` counterexample proves the old implementation misjudges "still advancing" as frozen. 8/8 |
| `test/relay-nochurn.js` | Browser (puppeteer, `__vx.startRelayPlayback()`) | **Regression**: after switching to relay, `scheduleRejoin(false)` must cancel the rebuild — `mode` stays `relay`, `rejoinInFlight` false, `rejoinAttempts` stays 0. Reverting the fix flips `mode` to `connecting`, `attempts=1` (3/6), i.e., the "switch to relay → rebuild P2P → fail again" oscillation |
| `test/selfheal.js` | Browser (puppeteer, canvas `captureStream` feeding `#video`) | **Regression**: after judging "picture alive" and cancelling this rebuild, it **must reschedule**. Reverting leaves `rejoinChecks` frozen at 1, `lastVideoTime` stops updating (5/7), exactly the "cancel is final → picture frozen until manual refresh" defect. 7/7 |
| `test/unload-no-leave.js` | Browser (puppeteer, `__sent` outbound instrumentation) | **P0 regression**: in `beforeunload`, `track.stop()` triggers `ended` → `endSession()` → sends `leave`, overriding the just-sent `host-away` and destroying the room immediately (breaking the README's promise of "seamless resume after refresh"). The case uses the `unloading` hook to build two control groups: normal stop `__sent=["leave"]`, during unload `__sent=[]`. Reverting the fix: leave still sent during unload (6/7) |
| `test/pause-watchdog.js` | Browser (puppeteer, real host+viewer two pages + `forceStall`) | **P1 regression**: when push is paused, the receiver's `framesDecoded` stops increasing, while `viewer-status` still reports periodically — the watchdog would **irreversibly** switch this display to relay after 15 seconds. Two A/B groups (`setPaused(false)` should degrade / `setPaused(true)` should not). Reverting the fix: group B `mode` becomes `relay` (3/5) |
| `test/rejoin-schedule.js` | Browser (puppeteer, real host room + two view pages) | **P1 regression**: ① `host-return`'s `scheduleRejoin(true)` must preempt the pending backoff timer (old code's `if (rejoinTimer) return` swallows it → picture permanently frozen); ② both `leave()` and `onHostGone()` must clear `rejoinTimer`/`rejoinInFlight`. **Two separate A/Bs**: reverting only the `onHostGone` one → 12/14. Plus a pre-guard self-check (the first `if (!roomCode \|\| !signal \|\| signal.state !== 1) return` in `scheduleRejoin` must pass): in A/B, `__signal.close()` breaks the precondition → that assertion turns red, dragging downstream cases down to 11/15 |
| `test/join-failed-backoff.js` | Browser (puppeteer, real host room + host-away grace window + `__joinLog` outbound instrumentation) | **P0 regression**: within the host-away grace window `room.host=null`, a display's rebuild join will always receive `join-failed`; old code called `scheduleRejoin(true)` in that branch (delay=0, no quota, no rate limit) → "join-failed → immediate join" RTT flood (locally measured **29,773 times in 4 seconds**). Fix routes through `scheduleRejoin(false)` backoff. Assertions: 4s window join ≤5, `rejoinAttempts>0` (quota consumed), `rejoinInFlight` stays true (backoff chain unbroken). Plus a force-preempts-force crash case where **the force timer must not decrement `rejoinAttempts` extra** (`rejoinTimerFromForce` source flag). **Separate A/Bs**: reverting Bug 1 fix → 29,773 times (5/8); reverting Bug 2 fix → `before=2 after=0` (7/8) |
| `test/server-restart-rejoin.js` | Browser (puppeteer, private-port standalone service + real host+viewer two pages + `SIGKILL` service then restart) | **P2.5 regression**: when the server process is killed/restarted, the viewer's ws closes → close handler only changes the banner without clearing `joined` → after signaling reconnects, open's `!joined` guard blocks re-joining, and the display becomes a "ghost" on the new server (new instance has no old room state, `room-closed` can't be resent). **Key precondition**: before killing the service, use `__host.forceStall` to force the session into relay (viewer has no pc to fail); otherwise in P2P mode old code self-heals slowly via `pc failed → scheduleRejoin`, and A/B can't catch the "permanently stuck" defect. Fix: close clears `joined` and sets `sessionSevered`, open destroys the old transport layer for a severed session (`destroy` resets mode to `connecting`, otherwise the backoff chain's "decision 1" misjudges the re-join as "already in relay" and cancels) + sets `rejoinInFlight` (join-failed goes through backoff chain) + immediately re-joins. **A/B**: reverting the fix → 10/14 (⑦ `joined` residual true, ⑪ `__joinLog` zero growth, ⑫ not rejoined, ⑬ banner stuck — 4 red) |
| `test/url-malformed.js` | Protocol-layer black box (real HTTP request to server) | **P1 regression**: `GET /%` (unescaped `%`) — old code's `decodeURIComponent` in `serveStatic` throws an **uncaught** `URIError` → process exit (DoS). Fix wraps decode in try/catch, returns 400 without dying. Assertions: returns 400 and the server process remains alive afterward. **A/B**: reverting Bug 2 fix → server exits (1/4, remaining assertions fail because the service is already dead) |
| `test/relay-frame-cap.js` | Protocol-layer black box (real host ws sends binary segments) | **P1 regression**: relay segments exceeding `RELAY_FRAME_MAX` (1MB) must be **dropped** by the server, without harming legitimate ≤1MB segments (max legitimate segment under 15Mbps/120ms is ~225KB). `frame()` simulates a real frame header with an 8-byte space-padded `viewerId` prefix. **A/B**: reverting Bug 8 fix → oversized segment forwarded (3/4, one assertion red because the large frame arrived) |
| `test/relay-degrade.js` | Browser (puppeteer, hijack `MediaSource` + fake signal feeding vx) | **P1 regression**: ① Bug 1 relay blob playback's `scheduleBlobPlay` must not re-schedule via `clearTimeout` (segments arriving faster than 1s → timer starves → permanent black screen); ② Bug 4 `addSourceBuffer` failure must degrade to `relay-blob` (handing over already-received segments); ③ Bug 6 `destroy()` must clear `blobTimer`. **Separate A/Bs**: reverting Bug 1 → black screen no recovery (5/6); reverting Bug 4 → stuck no degrade (5/6) |
| `test/host-stats-classify.js` | Browser (puppeteer, white-box `getPeers()`) | **P1 regression**: `cast.html`'s stats mistakenly classifies `p2p-relay` as `p2p`; fix: only `e.mode==='relay' \|\| e.mode==='p2p-relay'` counts as `relay` (aligned with `updateModeTag`). **A/B**: reverting Bug 3 fix → `p2p-relay` still counted as `p2p` (2/4) |
| `test/report-gating.js` | Browser (puppeteer, `__sent` outbound instrumentation) | **P1 regression**: when not connected (non-`connected`), `viewer.report()` must not send `viewer-status` (empty payload would pollute the watchdog's freshness guard). Uses delta counting (asserts `sent.length - before`) to avoid cumulative counting going red in A/B due to "invalid reports that should have been sent anyway". **A/B**: reverting Bug 9 fix → still reports when disconnected (1/2) |
| `test/turn-urls-split.js` | Browser (puppeteer, white-box `Cast.buildIceServers`) | **P1 regression**: `turn.urls` as comma-separated string (`turn:a,turn:b`) must be split into multiple entries; old code stuffed the whole string into `rtcConfig.iceServers[].urls` (a comma string that's neither string nor array) → that TURN is invalid. **A/B**: reverting Bug 7 fix → comma string not split (1/4) |
| `test/addviewer-vs-reset.js` | Browser (puppeteer, hijack `RTCPeerConnection.createOffer` gate + `__signal.close()`) | **Guard lock**: Bug 5 report claims `cast.html`'s `viewerMap` and `host.peers` have a "brief decoupling window" that leaves zombie peers; measured the window is **unreachable** (`insert-before-await` + `delete-on-reset` make zombies unreachable), so this case isn't "revert-fix-turns-red" but **proves the revert path is safe** — a pending `addViewer` at disconnect produces no orphan peer after reconnect (4/4 always green, as a defensive invariant contract) |

> The two `replaced`-related tests originally existed only in a dev temporary directory and were not shipped with the project, causing this document's references to point to non-existent files. They are now included in `test/` and wired into `npm test`. They are the evidence chain for the argument "why keep the `replaced` dead code" — without them the 0/5 and A/B conclusions can't be re-verified.
>
> **All 28 case files** in the table above are in the repo's `test/` directory, scheduled uniformly by `test/run-all.js`'s `SUITES`; the previous "dev-period cases" (`stale-cond` / `relay-nochurn` / `selfheal` / `crossroom`) have all been promoted to formal files, no longer dead references.

**Signaling from a normal display is still forwarded normally** (the guard only targets dead/replaced connections): `offer`/`answer`/`ice`/`viewer-status` all work as usual, and binary relay frames also go through `room.host.send`. Any "the guard slowed/broke the normal flow" regression would surface in the "not falsely harmed" group of these two tests.

**Path B: Really ended (click stop / change room code)**

The sender sends `leave`, the server immediately `destroyRoom`s and broadcasts `room-closed`, and the display returns to standby.

| Scenario | Sender | Display |
|---|---|---|
| Page refresh / signaling jitter | Sends `host-away`, clears `roomCode` + viewer list + all transport-layer peers, auto-reconnects and **reuses the original room code**, then sends `host-return` | Banner "Connection unstable, recovering…" (persistent); after receiving `host-return` changes to "Recovered" and auto-fades; returns to standby only if 15s timeout |
| Active stop / change room code | Sends `leave`, invalidates room | Immediately receives `room-closed`, returns to standby |

**Division of labor between the two-tier recovery mechanisms** (same goal, opposite means — boundaries must be clear):

| Symptom | Judge | Handling |
|---|---|---|
| Picture stalled but **host still present** (P2P silent degradation) | Host-side watchdog (15s no decode growth) | Degrade to server relay |
| **Host gone** — received `host-return` (strong signal) | Display side | Rebuild immediately, skip health check |
| **Host gone** — connection `failed` (weak signal) | Display side | Backoff, re-confirm via `currentTime`, then rebuild |

The display does **not** run periodic picture-stall detection — otherwise the picture stopping would trigger reconnect, P2P works again after reconnect, the host side never gets a chance to degrade, and relay fallback fails.

When the sender's signaling disconnects, it must **clear three states simultaneously**, otherwise ghost displays remain:

- `roomCode` not cleared → after reconnect `ensureRoom()` returns directly, room never rebuilt;
- `viewerMap` (UI layer) not cleared → in the reconnected empty room, old viewerIds still show as a display, polluting link-label aggregation;
- `host.peers` (transport layer) not cleared → old `RTCPeerConnection` never reclaimed. When the display auto-rejoins with a **new** viewerId, new+old stacking inflates stats long-term.

Of the three, the transport layer is most easily missed: clearing only the UI makes the page look fine (counts zeroed), but `peers` always keeps the old entries.

#### Signaling layer's `close()` vs `reconnectNow()`: one word apart, opposite results

The signaling layer (`public/js/core.js`) provides two methods to "disconnect the current ws", with **completely opposite** semantics — mixing them causes "user permanently kicked offline":

| Method | Behavior | Use case |
|---|---|---|
| `close()` | Sets `closedByUser = true`, after which `ws.onclose` **directly returns**, the signaling layer **never reconnects** | Only when the page is about to unload (`beforeunload`) — indeed it shouldn't reconnect then |
| `reconnectNow()` | Disconnects the current ws and goes through **normal exponential backoff reconnect** | Any scenario needing "switch to a new ws and continue" |

**Why `close()` can't be used for "want to reconnect"**: `closedByUser` is a one-way flag, never reset in `connect()`. Once called, any subsequent disconnect won't trigger reconnect, the page permanently stuck at "connection interrupted", only a refresh helps.

`reconnectNow()` has three internal treatments, **none of which can be omitted** — omitting any silently breaks it:

**1. Unconditionally reset `closedByUser = false` and `retry = 0`**

- Not resetting `closedByUser` → this method's correctness **depends on call order**: as long as someone (even code elsewhere) called `close()` once, the residual `true` short-circuits all subsequent `reconnectNow()`. After reset, the method is self-contained: no matter what happened before, calling it always reconnects.
- Not resetting `retry` → the two branches behave inconsistently. After the `OPEN` branch's `ws.close()`, `onclose` computes `600 * 1.6^retry` using the **current** retry; if 5 consecutive failures happened before (`retry=5`), the user clicking "reconnect" would wait ~6.3 seconds to start, contradicting "reconnect immediately" semantics. So `retry = 0` is hoisted before the branch, both paths count from 0.

**2. `readyState` must be three branches, not `>= 2`**

WebSocket's `onclose` **only dispatches once**, but `CLOSING(2)` and `CLOSED(3)` are opposite in "whether `onclose` has dispatched":

| readyState | Meaning | onclose dispatched? | Correct handling |
|---|---|---|---|
| `1` OPEN | Normal | No | Actively `ws.close()`, let `onclose` do backoff reconnect |
| `2` CLOSING | Closing (during handshake) | **No, about to dispatch** | **Remove old socket's event callbacks**, then immediately `connect()` |
| `3` CLOSED | Closed | Yes | Directly `connect()` — another `ws.close()` produces no new event |

Merging `2` and `3` into `>= 2` (as the early implementation did) causes the ws created during **CLOSING** to become an orphan connection:

```
Directly connect() during the CLOSING window
  → connect() creates A, module-level ws points to A
  → tens of ms later old socket's onclose dispatches (closedByUser was just reset to false)
  → setTimeout(connect, delay) → connect() again creates B, ws now points to B
  ⇒ A is unreferenced, but the underlying socket is still OPEN — keeps receiving server
    messages with no handler, and the server mistakenly thinks this browser has two active ws
```

Why CLOSING chooses "remove callbacks + immediately reconnect" instead of "do nothing, wait for onclose": the latter also produces no orphan, but the user waits tens to hundreds of milliseconds to recover. `reconnectNow()`'s semantics is "switch to a new one immediately", so it removes old callbacks to eliminate the collision risk while immediately building the new connection.

**3. The three branches' boundaries must be precisely determined by `readyState`**, not by range comparisons like `>=` — `CLOSING` and `CLOSED` have **opposite** handling, and grouping them is the root cause of this bug.

A/B verification across the board:

| Defect | Behavior after reverting the fix | Test |
|---|---|---|
| Not resetting `closedByUser` | Still can't connect after `reconnectNow()` | `test/reconnect.js` `5/6` |
| Only reset, no dead-connection branch | Same (CLOSED's `onclose` no longer dispatches) | `test/reconnect.js` `5/6` |
| `readyState >= 2` (CLOSING misjudged) | After reconnect **two ws OPEN simultaneously**, one is orphan | `test/reconnect-closing.js` `4/6`, observed `openNow=2` |


> **Degradation is irreversible**: `enableRelay()` sets mode to `relay` only after success; if initialization fails it sets `failed` (instead of staying at `relay`), so the sender won't mistakenly show "server relay", while keeping retry opportunity.

### About "silent interruption" detection

WebRTC has a trap: when the network quietly drops, `connectionState` may stay `connected` for a long time, so looking at state alone can't tell the link is dead. Hence an extra **frame-level liveness watchdog**.

The basis is the **receiver-reported `framesDecoded`** (real decoded frame count), not the sender's `framesEncoded`. The reason is practical:

- When capturing a **static desktop**, the encoder may output zero for a long time; using the sender metric would misjudge a healthy low-latency P2P as failed;
- The viewer is mostly parked as a monitor; when the page goes to background, Chrome/Safari throttle timers **to minute-level**, so "how long since last report" also can't be a failure basis.

So degradation only happens when "the receiver has 15 consecutive seconds of zero growth in decoded frames", and real disconnects are directly covered by `connectionState` / `iceConnectionState` changes.

**The report itself is also throttled**, so "how long since last report" is only used to **skip** this round's judgment, never to **trigger** degradation:

- If over 30 seconds since the last report, the receiver's report is throttled or interrupted, and it's impossible to judge whether the peer is actually decoding → skip this round entirely, neither accumulating stall time nor degrading;
- Only when reports keep arriving normally and `framesDecoded` has 15 consecutive seconds of no growth is silent interruption confirmed.

Otherwise a subtle false positive appears: background tab timers throttled → reports stop → `decodedGrew` frozen at the last `false` → stall timer keeps accumulating → after 15 seconds a **healthy P2P connection** is degraded to relay.

### Link type determination

**Does not** use coarse SDP-based judgment. As long as `buildIceServers()` includes TURN, the local SDP necessarily contains `typ relay` candidates (even if actually using host/srflx), so coarse judgment reliably gives wrong answers in TURN-configured environments.

The correct approach: at connection time first give a neutral state `p2p-pending`, then asynchronously query the candidate pair with `state=succeeded && nominated` in `getStats()`, reading its local/remote `candidateType` to get the real link: `host` → LAN direct, `srflx`/`prflx` → P2P direct, `relay` → TURN relay.

## Configuring TURN (more stable across public networks)

It works without TURN (STUN + relay fallback). But if both ends are behind strict NAT / corporate firewalls, a TURN server helps a lot:

```bash
PORT=8080 \
TURN_URL=turn:your-server.com:3478 \
TURN_SECRET=your_coturn_static_auth_secret \
node server/server.js
```

The server uses coturn's REST API to **dynamically issue temporary credentials** (HMAC-SHA1, 24-hour validity by default), without exposing long-term passwords to the frontend.

coturn deployment reference:

```bash
# Ubuntu
sudo apt install coturn
# /etc/turnserver.conf
listening-port=3478
fingerprint
use-auth-secret
static-auth-secret=your_coturn_static_auth_secret
realm=your-server.com
```

## Display Controls

| Action | Description |
|---|---|
| Move mouse over picture | Bring up floating control bar (auto-hides after 3 seconds) |
| `F` or double-click picture | Toggle fullscreen |
| `B` | Blackout protection (picture hidden but connection kept, for temporary masking) |
| `S` | Toggle scale mode (fit ↔ fill-crop) |
| `Esc` | Exit blackout |
| Click picture | Resume playback (when browser blocks autoplay) |

## Sender Features

- **Quality tiers**: Smooth 1.5M / Standard 4M / HD 8M / Ultra 15M
- **Frame rate**: 15 / 30 / 60 fps
- **System audio**: optional capture (must be set before starting cast)
- **Pause**: temporarily stop pushing, picture freezes
- **New room code**: invalidate old room, generate new code
- **Live stats**: resolution / frame rate / bitrate / duration / link and latency per display

## Security

- Room code is 4 digits, charset excludes confusable characters (`0/O/1/I`), generated by `crypto.randomInt`
- Max 8 displays per room
- Rooms auto-reclaimed after 6 hours of inactivity
- Room invalidated immediately when sender stops casting / closes page, displays receive notification

## Browser Requirements

Requires a modern browser supporting `getDisplayMedia` + `MediaRecorder` + `MediaSource` (recent Chrome / Edge / Firefox).

> **HTTP environment note**: browsers usually only expose screen capture under HTTPS or `localhost`. This project by default allows LAN private ranges (`10.x` / `192.168.x` / `172.16-31.x` / `*.local`), so accessing `http://192.168.x.x:8080` directly within the LAN works. For public deployment, be sure to use HTTPS.

## Project Structure

```
screencast/
├── server/
│   └── server.js          # static hosting + WebSocket signaling + room management + binary relay + TURN credentials
├── public/
│   ├── index.html         # homepage navigation
│   ├── cast.html          # sender console
│   ├── view.html          # receiver display
│   ├── style.css          # global styles (pure white minimalist)
│   └── js/
│       ├── core.js        # shared layer: signaling wrapper / ICE config / link determination / QR code
│       ├── host.js        # sender transport layer: multi-viewer connections + watchdog + relay streaming
│       ├── viewer.js      # receiver transport layer: P2P playback + MediaSource relay playback
│       └── qrcode.js      # QR code generation (third-party lib, bundled locally, no external link)
├── test/
│   ├── run-all.js             # test entry: start server → run cases in order → clean up
│   ├── replaced-guard.js      # protocol layer: non-host connection forwarding + replaced root cause
│   ├── replaced-guard-race.js # protocol layer: unreachability + white-box A/B
│   ├── crossroom.js           # protocol layer: old room reference cleanup on cross-room switch
│   ├── reconnect.js           # browser: close()/reconnectNow() semantics
│   ├── reconnect-closing.js   # browser: CLOSING window produces no orphan connection
│   ├── replaced-ux.js         # browser: link text after replaced
│   ├── quality-injection.js   # browser: new display gets user's current quality selection
│   ├── newcode-cleanup.js     # browser: clear transport-layer peers on code change
│   ├── viewer-teardown.js     # browser: receiver destroys transport layer after host ends
│   ├── concurrent-addviewer.js # browser: concurrent addViewer must not wrongly push relay
│   ├── answer-seq.js         # browser: reject stale answers by generation number
│   ├── stale-cond.js          # browser: picture-freeze judgment time-window/baseline semantics
│   ├── relay-nochurn.js       # browser: no idle P2P rebuild in relay mode
│   ├── selfheal.js            # browser: must reschedule after cancelling rebuild
│   ├── viewer-status-id.js    # protocol layer: viewerId / type must not be overwritten by payload
│   ├── unload-no-leave.js     # browser: must not send leave during unload
│   ├── pause-watchdog.js      # browser: pause must not be misjudged as silent interruption
│   ├── rejoin-schedule.js     # browser: host-return preemption + leave cleanup
│   ├── join-failed-backoff.js # browser: join-failed backoff rate-limit + force preemption counting
│   ├── server-restart-rejoin.js # browser: display auto-rejoins after server restart (P2.5)
│   ├── url-malformed.js       # protocol layer: malformed URL doesn't kill service (GET /% → 400)
│   ├── relay-frame-cap.js     # protocol layer: relay segment 1MB cap (drop oversized)
│   ├── relay-degrade.js       # browser: blob timer flood / addSourceBuffer degrade
│   ├── host-stats-classify.js # browser: stats classifies p2p-relay into relay
│   ├── report-gating.js       # browser: don't send invalid viewer-status when disconnected
│   ├── turn-urls-split.js     # browser: buildIceServers normalizes TURN addresses
│   ├── addviewer-vs-reset.js  # browser: pending addViewer at disconnect leaves no zombie (guard lock)
│   └── static-hygiene.js      # static: unused destructured variables + comment contracts
├── package.json
├── pnpm-lock.yaml         # dependency lock (ws only; ignorable when installing with npm)
└── README.md
```

The form and assertions of each case file under `test/` are in the [Running Tests](#running-tests) section; `npm test` is the full entry point.

## HTTP Endpoints

| Path | Description |
|---|---|
| `GET /api/config` | Get ICE configuration (including dynamic TURN credentials) |
| `GET /api/health` | Health check, returns room count and uptime |
| `GET /cast` | Sender page |
| `GET /view` | Receiver page (supports `?r=ABCD` to prefill room code) |

## Debugging & Automated Testing

Both pages support `?debug=1`, which does exactly one thing: exposes internal state on `window` for automated scripts to read. Using it in production adds no side effects.

| Page | Global object | Purpose |
|---|---|---|
| Sender `/cast?debug=1` | `window.__signal` | Signaling instance (including `.socket`, can force-disconnect to simulate drop) |
| | `window.__host` | Transport layer instance (including `peerIds` current peer id list, `peerModes` id→mode map, `peerState(id)` pc connection state, `peerLiveness(id)` watchdog input, `forceStall(id, s)` push stall timestamp back, `setPaused(bool)` pause toggle) |
| | `window.__sent` | Outbound signaling trace (`[{type, t}]`), for asserting "a message was **not** sent" |
| | `window.__endSession` / `__setUnloading` | Directly drive the session-end path, reproducing behavior during unload |
| | `window.__forceStarted` | Set `started`, letting automation reach the branch after the `if (!started) return` guard (e.g., the "new code" button) — headless can't go through `getDisplayMedia`'s system picker |
| Display `/view?r=CODE&debug=1` | `window.__signal` | Signaling instance (**implemented as getter**, instance changes on reconnect), for waiting OPEN and reading rtt |
| | `window.__vx` | Receiver transport layer (`mode` / `localStats()` / `report()`). **Implemented as getter**: `vx` is wholesale replaced at runtime (`relay-begin` / `onHostGone`), a one-time assignment would make tests watch a destroyed old instance |
| | `window.__rejoin` | Internal handles of the rebuild flow (see below) |
| | `window.__joinLog` | `doJoin` outbound timestamp array, for asserting the join-failed chain's retry rate (`signal.send` is written via `defineProperties` and can't be wrapped, so it's instrumented only at the send point) |

`window.__rejoin` provides the following methods to construct scenarios that can't naturally appear end-to-end:

```js
__rejoin.schedule(t0, force)  // reset baseline to "no baseline", then trigger a rebuild per force
__rejoin.reset()              // clear rebuild backoff state (attempts / inFlight / timer)
__rejoin.alive()              // directly call isPictureAlive()
__rejoin.fresh()              // whether the last alive() returned the "cannot judge" optimistic value
__rejoin.probe()              // read { lastVideoTime, lastVideoAt, rejoinAttempts, rejoinChecks,
                              //        rejoinInFlight, timerPending }
__rejoin.hostGone(reason)     // directly trigger onHostGone (covering the independent entry not via leave())
__rejoin.forceStale(secs)     // set baseline to "picture stalled" (lastVideoTime=current, lastVideoAt pushed back)
__rejoin.staleConditions()    // expose the two sub-conditions of stall judgment one by one (for independent assertions)
```

**Why it's needed**: `isPictureAlive()`'s "first call optimistically returns true" branch can only trigger when a baseline was **never established**, but this premise is almost impossible to construct naturally end-to-end — a host refresh necessarily puts the display's `pc` into `failed` first, and that path has already established a baseline, masking the defect. `__rejoin.schedule(t0, force)` directly manipulates the baseline state, letting this branch be deterministically reproduced and asserted.

### Running Tests

```bash
npm test
```

Orchestrated by `test/run-all.js`: automatically (or reuse) starts the signaling service → runs all cases under `test/` in order → final cleanup. The port can be overridden with `TEST_PORT` (default `8080`).

Browser cases (21 total, including `reconnect.js` / `rejoin-schedule.js` / `join-failed-backoff.js` / `server-restart-rejoin.js` / `relay-degrade.js` etc.) need **Chromium + `puppeteer-core`** (dev dependency). Without `puppeteer-core`, these cases print `SKIP` and exit 0, and do **not** hard-fail `npm test` — users who installed only runtime dependencies can still run protocol-layer and static cases. To avoid "skips misreported as passes", `run-all.js` distinguishes `SKIP` from `PASS`: the summary line explicitly writes "X/28 passed, Y skipped", and only exits non-zero on a **real failure**. To run fully:

```bash
npm i -D puppeteer-core      # or after making it globally available, set CHROME_PATH to chromium
CHROME_PATH=/usr/bin/chromium npm test
```

## Project Screenshot

![project-screenshot](project_screenshot.png)

## License

[MIT](LICENSE)
