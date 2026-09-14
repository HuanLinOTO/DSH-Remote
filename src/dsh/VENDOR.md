# Vendored ds-harness-remote protocol stack

These files are vendored verbatim (import paths rewritten to relative) from
[ds-harness-remote](https://github.com/liguobao/ds-harness-remote), MIT licensed.

- Source commit: `4f77a4f9a41edb0c7728f6f4c8d3f5d37cbc9b07` (protocol schema alignment v3: `harness.remote.v3` session format, §23 error codes, §24 default limits, Account Authorization schemas)
- `protocol/` ← `packages/protocol/src/index.ts` (v1 envelope, control frames, SecureMessageCodec DSHF fragmentation, transfer limits)
- `crypto/` ← `packages/crypto/src/{index,noise}.ts` (X25519/ChaCha20Poly1305 helpers, Noise IK session via @lukeburns/clatterjs)
- `webrtc/` ← `packages/webrtc/src/*.ts` (AdaptiveTransport: Control WSS + WebRTC/Relay data plane)
- `client-core/` ← `packages/client-core/src/*.ts` (RemoteClientCore RPC correlation, feature probing, alpha Harness client)
- `__tests__/` ← each package's vitest suite, plus the protocol conformance fixtures in `fixtures/`

Upstream dependencies added to package.json: `zod`, `@noble/ciphers`, `@noble/curves`,
`@noble/hashes`, `@lukeburns/clatterjs` (all browser-compatible; MIT).

Do not hand-edit protocol behavior here; changes belong upstream. Local deviations
from the source commit, all of which must survive the next sync:

1. Import-path rewrites (`@dsh-remote/*` packages → relative paths, no `.js` suffixes).
2. `__tests__/protocol/conformance-fixture-loader.ts` reads fixtures from a local path
   instead of a URL, and carries extra `FixtureOperation`s merged from upstream.
3. `client-core/codex-client.ts` is intentionally NOT vendored (Codex App Server domain;
   this client only talks to DeepSeek Harness Hosts), so `client-core/index.ts` omits its
   export. Codex types/constants inside `protocol/index.ts` are kept verbatim.
4. `client-core/harness-alpha-client.ts`: `sessionRename` RPC, `session/renamed` frame
   forwarding for `title` projections (other projections are suppressed — see the comment
   in `applyProjection`), and `liftSessionProjectionFields` for flat legacy session rows.
5. `client-core/remote-gateway.ts`: two `[dsh-debug]` console.debug lines around
   `harness.remote.stream.open`.
6. Tests: `// @vitest-environment node` headers, local TS fixes, `ScriptedCore.responses`,
   and the local rename/lift/suppression suites; the upstream "normalizes legacy code
   preset in live projection frames" test is rewritten as the suppression test because
   this client does not emit `session/projection` frames.
