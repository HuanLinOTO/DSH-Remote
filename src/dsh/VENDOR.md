# Vendored ds-harness-remote protocol stack

These files are vendored verbatim (import paths rewritten to relative) from
[ds-harness-remote](https://github.com/liguobao/ds-harness-remote), MIT licensed.

- Source commit: `f2f1c7aec7743c75fcdcd900c59a5277a195cbd0`
- `protocol/` ← `packages/protocol/src/index.ts` (v1 envelope, control frames, SecureMessageCodec DSHF fragmentation, transfer limits)
- `crypto/` ← `packages/crypto/src/{index,noise}.ts` (X25519/ChaCha20Poly1305 helpers, Noise IK session via @lukeburns/clatterjs)
- `webrtc/` ← `packages/webrtc/src/*.ts` (AdaptiveTransport: Control WSS + WebRTC/Relay data plane)
- `client-core/` ← `packages/client-core/src/*.ts` (RemoteClientCore RPC correlation, feature probing, alpha Harness client)
- `__tests__/` ← each package's vitest suite, plus the protocol conformance fixtures in `fixtures/`

Upstream dependencies added to package.json: `zod`, `@noble/ciphers`, `@noble/curves`,
`@noble/hashes`, `@lukeburns/clatterjs` (all browser-compatible; MIT).

Do not hand-edit protocol behavior here; changes belong upstream. The only local
modifications are import-path rewrites and the fixture root URL in
`__tests__/protocol/conformance-fixture-loader.ts`.
