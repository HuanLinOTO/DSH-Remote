# DSH Remote

[中文](./README.md) | English

A **third-party desktop / Android client** for [ds-harness-remote](https://github.com/liguobao/ds-harness-remote):
sign in to a DSH Remote Server account, pick an online Host, and drive a remote DeepSeek Harness over an
end-to-end encrypted (Noise IK) tunnel — send text and images, watch streaming replies and tool calls,
answer approvals and questions, cancel runs, and switch models.

The UI layer is **derived from [OpenCodeUI](https://github.com/lehhair/OpenCodeUI)** (Tauri 2 + React 19,
GPL-3.0). On top of its chat rendering, multi-pane layout, theming and mobile shell, this fork reworks the
experience for *remote Host + mobile*: collapsed process blocks, a live connection-path badge, heartbeats
that survive a frozen WebView, and streaming that stays smooth in long sessions.

## Relationship to upstreams

| Upstream | Relationship | What we take from it |
| --- | --- | --- |
| [lehhair/OpenCodeUI](https://github.com/lehhair/OpenCodeUI) | **UI upstream / direct ancestor** | Starting point for the frontend and desktop shell (chat rendering, panes, terminal, themes, Tauri shell). This repo is a GPL-3.0 derivative work and keeps the original license and attribution. |
| [liguobao/ds-harness-remote](https://github.com/liguobao/ds-harness-remote) | **Protocol & server upstream** | Vendored `packages/protocol`, `packages/webrtc`, `packages/client-core` (see `src/dsh/VENDOR.md`). This repo is a third-party client, **not** the official one. |
| `@deepseek-ai/dsh web` | The Host runtime being driven remotely | Official npm package, not part of this repo. |
| DSH Remote Server | Control channel / relay / signaling | Official deployment at <https://dsh.r2049.cn>. |

> This repo is neither an official fork of OpenCodeUI nor the official client of ds-harness-remote.
> For protocol details, the upstream documents are authoritative
> (`ds-harness-remote/docs/protocol.md` is the wire-protocol spec).

## Preview

![DSH Remote session on an Android tablet](docs/images/tablet-chat.webp)

(Android tablet over a direct P2P path; the status bar shows the selected transport and the Host working directory.)

## What changed compared to OpenCodeUI

- **Remote session support** — the official `harness.api.*` (rc.2) / `harness.remote.*` (alpha) tunnels
  drive a `sessionStore` state machine (bootstrap → login → host list → connect → chat);
  `session.history` restores history and mux frames stream live text / reasoning / tool cards / approvals.
- **Connection experience** — adaptive `lan > p2p > turn > relay` transport with a title-bar badge showing the
  actually selected path and RTT; the control channel is dialed from Rust via tokio-tungstenite (no `Origin`
  header, so the server's origin allowlist cannot reject it), and application-level heartbeat pongs are answered
  natively in Rust, so a frozen WebView in the background no longer drops the connection.
- **Process collapsing** — each turn's intermediate work folds into an “已处理 Xm Ys” / “Worked for Xm Ys”
  block, leaving the final answer outside it (on by default; toggle in Settings → Chat).
- **Rendering performance** — reference-stable ChatItem → UI Message projection (WeakMap cache), throttled
  bridge pushes (~10 fps) and virtualized scrolling keep long streaming sessions responsive.
- **Mobile** — Tauri Android (arm64 / armeabi-v7a) with status-bar insets, safe areas, a three-pane pager,
  vertically centered host list, and a “switch host” entry in the sidebar.
- **Branding & data migration** — every `dsh-*` localStorage key, IndexedDB database and DOM marker is renamed,
  with a one-shot migration of legacy keys at startup (`src/utils/legacyStorageMigration.ts`).

## Download

Grab the latest build from [Releases](https://github.com/HuanLinOTO/DSH-Remote/releases):

| Platform | Artifact |
| --- | --- |
| Android | `DSH-Remote-<version>-android-arm64.apk` / `-armv7.apk` (package `cn.r2049.dsh.remote`) |
| Windows | NSIS installer `.exe` |
| macOS | `.dmg` (Apple Silicon / Intel) |
| Linux | `.deb` |

The Android signing key is not committed (`src-tauri/gen/android/dsh-remote.keystore`, git-ignored):
official builds always use the same key, so **install APKs from the same source** — otherwise Android
refuses to update over an existing install because of a signature mismatch.

## Features

- **Sign-in** — Zhihu OAuth / GitHub OAuth (system browser → `dshremote://oauth` redirect registers the device)
  or email + password; a local X25519 device identity is generated and registered
  (`POST /api/v1/devices/register`); access tokens refresh automatically before expiry.
- **Host list** — Hosts under the same account (presence / version / fingerprint); selecting one runs
  `connect.request → connect.incoming → Noise IK handshake`, with a status bar tracking
  auth → transport → secure → loading → ready.
- **Sessions** — `workspace.list` to pick a workspace, a sidebar grouped by Host workspace, history restore
  plus the live stream; rename, pin, archive and lazily create sessions.
- **Interaction** — send text and images (>2 MiB goes through chunked transfer), `session.cancel`,
  model switching, approval / question responses, exponential-backoff reconnect with history reload.
- **Protocol compliance** — only the official upstream tunnels are used; the protocol stack is vendored
  from `ds-harness-remote` and covered by conformance tests.

## Development

```bash
npm install
npm run dev        # vite; dev proxies /api and /ws to https://dsh.r2049.cn (override with VITE_DSH_SERVER)
npm run validate   # typecheck + lint + test + build
npm run tauri dev  # desktop app (starts vite first, then Rust)
```

Sign-up: <https://dsh.r2049.cn/app/register>.

## Android APK

```bash
# release (signed automatically when gen/android/keystore.properties exists)
npx tauri android build --apk --target aarch64
# output: src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk

adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```

`keystore.properties` must define `storeFile` / `storePassword` / `keyAlias` / `keyPassword`
(both the keystore and the properties file are git-ignored — **losing them means installed releases can no
longer be updated, so back them up**). To let CI publish signed APKs, configure the repository secrets
`KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS` and `KEY_PASSWORD`; without them the release workflow
skips the Android artifacts.

## Self-hosting (same-origin reverse proxy)

```bash
docker compose -f docker-compose.standalone.yml up -d --build
```

`docker/Caddyfile.standalone` serves the static build and proxies `/api` and `/ws` to `$DSH_SERVER`
(defaults to `dsh.r2049.cn:443`), avoiding browser cross-origin restrictions. Tauri desktop and Android
builds are unaffected by CORS.

## Architecture

```
OpenCodeUI UI (ChatArea / InputBox / Sidebar / ModelSelector /
               PermissionDialog / QuestionDialog / mobile three-pane pager)
        │  Message{info, parts[]} (render boundary)
┌───────▼────────────────────────────────────────────┐
│ dsh adapter layer (src/dsh/)                        │
│  event-reducer.ts (native events → ChatItem, pure)   │
│  toUiMessages.ts (ChatItem → Message/Part, stable)   │
│  sessionStore (connection / sessions / approvals)    │
│  RemoteApiProxy(rc.2) ── HarnessAlphaClient(alpha)   │
│  RemoteClientCore + SecureTransport(Noise IK)        │
│  AdaptiveTransport(Control WSS + WebRTC/Relay)       │
│  RemoteServerApi (REST: login/register/refresh/TURN) │
└───────┬────────────────────────────────────────────┘
        │ HTTPS + WSS
DSH Remote Server ──relay──▶ Host plugin (real Harness)
```

## License & attribution

- Released under **GPL-3.0-only**, inherited from [OpenCodeUI](https://github.com/lehhair/OpenCodeUI);
  upstream copyright and license notices are in [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).
- The protocol stack is vendored from [ds-harness-remote](https://github.com/liguobao/ds-harness-remote) (MIT);
  provenance and local modifications are documented in `src/dsh/VENDOR.md`.
- Upstream leftovers intentionally kept: `@opencode-ai/sdk` type imports, `docker/`, `openapi*.json`.
