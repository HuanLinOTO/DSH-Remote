// End-to-end control-channel rig: the REAL vendored AdaptiveTransport runs over
// the REAL TauriBridgeWebSocket, whose invoke mock emulates the exact semantics
// of the Rust bridge commands (bridge_connect / bridge_send / bridge_disconnect)
// against a minimal local WebSocket server speaking the DSH control protocol.
//
// Scenarios:
//   1. happy path — control handshake + relay round trip + graceful close
//   2. origin rejection — the server closes with 4010 right after the upgrade;
//      the vendored handshake must reject with that exact detail (regression
//      guard for the WebView origin failure this bridge exists to fix)
//   3. dial failure — the bridge command rejects; the transport must not hang

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import net from 'node:net'
import crypto from 'node:crypto'

const bridgeRig = vi.hoisted(() => {
  return {
    impl: null as ((command: string, payload: unknown) => Promise<unknown>) | null,
  }
})

vi.mock('@tauri-apps/api/core', () => {
  class FakeChannel {
    onmessage?: (event: unknown) => void
  }
  return {
    Channel: FakeChannel,
    invoke: (command: string, payload?: unknown) => {
      if (bridgeRig.impl === null) throw new Error(`bridge rig: no invoke impl for ${command}`)
      return bridgeRig.impl(command, payload ?? {})
    },
  }
})

import { AdaptiveTransport } from '../../vendor/webrtc'
import { PROTOCOL_VERSION } from '../../vendor/protocol'
import { installTauriControlWebSocket } from '../tauri-websocket'

// The vendored transports dial the GLOBAL WebSocket; install the Tauri bridge
// proxy exactly like the app bootstrap does, so the rig exercises the adapter.
beforeEach(() => {
  ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
  installTauriControlWebSocket()
})

const nativeWebSocket = window.WebSocket

afterEach(() => {
  window.WebSocket = nativeWebSocket
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  delete (window as unknown as { __dshControlWebSocketInstalled?: boolean }).__dshControlWebSocketInstalled
})

// ---------------------------------------------------------------------------
// Minimal RFC6455 codec — client frames are masked, server frames are not.
// ---------------------------------------------------------------------------

interface RawFrame {
  opcode: number
  payload: Buffer
}

function decodeServerFrames(buffer: Buffer): { frames: RawFrame[]; rest: Buffer } {
  const frames: RawFrame[] = []
  let offset = 0
  while (offset + 2 <= buffer.length) {
    const opcode = buffer[offset]! & 0x0f
    const masked = (buffer[offset + 1]! & 0x80) !== 0
    let length = buffer[offset + 1]! & 0x7f
    let cursor = offset + 2
    if (length === 126) {
      if (cursor + 2 > buffer.length) break
      length = buffer.readUInt16BE(cursor)
      cursor += 2
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break
      length = Number(buffer.readBigUInt64BE(cursor))
      cursor += 8
    }
    let maskKey: Buffer | undefined
    if (masked) {
      if (cursor + 4 > buffer.length) break
      maskKey = buffer.subarray(cursor, cursor + 4)
      cursor += 4
    }
    if (cursor + length > buffer.length) break
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length))
    if (maskKey !== undefined) {
      for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ maskKey[i % 4]!
    }
    frames.push({ opcode, payload })
    offset = cursor + length
  }
  return { frames, rest: buffer.subarray(offset) }
}

function encodeClientTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8')
  const mask = crypto.randomBytes(4)
  const masked = Buffer.from(payload)
  for (let i = 0; i < masked.length; i++) masked[i] = masked[i]! ^ mask[i % 4]!
  let head: Buffer
  if (payload.length < 126) {
    head = Buffer.from([0x81, 0x80 | payload.length])
  } else {
    head = Buffer.alloc(4)
    head[0] = 0x81
    head[1] = 0x80 | 126
    head.writeUInt16BE(payload.length, 2)
  }
  return Buffer.concat([head, mask, masked])
}

function encodeServerTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8')
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload])
  const head = Buffer.alloc(4)
  head[0] = 0x81
  head[1] = 126
  head.writeUInt16BE(payload.length, 2)
  return Buffer.concat([head, payload])
}

function encodeServerClose(code: number, reason: string): Buffer {
  const body = Buffer.alloc(2 + Buffer.byteLength(reason))
  body.writeUInt16BE(code, 0)
  body.write(reason, 2)
  return Buffer.concat([Buffer.from([0x88, body.length]), body])
}

// ---------------------------------------------------------------------------
// Fake DSH Remote server + fake Rust bridge
// ---------------------------------------------------------------------------

interface BridgeEntry {
  channel: { onmessage?: (event: unknown) => void }
  sendFrame: (text: string) => void
  endSocket: () => void
  fail: (message: string) => void
}

function startRig(options: { silentHello?: boolean } = {}): Promise<{
  url: string
  upgraded: () => boolean
  rejectWithOriginError: () => void
  close: () => void
}> {
  const connections = new Map<string, BridgeEntry>()
  let upgradedFlag = false
  let rejectWithOriginError: (() => void) | undefined

  const server = net.createServer(socket => {
    let sawUpgrade = false
    let buffer: Buffer = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (!sawUpgrade) {
        const idx = buffer.indexOf('\r\n\r\n')
        if (idx === -1) return
        const request = buffer.subarray(0, idx).toString('utf8')
        const key = /Sec-WebSocket-Key: (.+)/.exec(request)?.[1]?.trim() ?? ''
        const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        )
        buffer = buffer.subarray(idx + 4)
        sawUpgrade = true
        upgradedFlag = true
        rejectWithOriginError = () => {
          socket.write(encodeServerClose(4010, 'origin not allowed'))
          socket.end()
        }
        return
      }
      const { frames, rest } = decodeServerFrames(buffer)
      buffer = rest
      for (const frame of frames) {
        if (frame.opcode === 8) {
          socket.end()
          return
        }
        if (frame.opcode !== 1) continue
        const event = JSON.parse(frame.payload.toString('utf8')) as {
          type: string
          payload: Record<string, unknown>
        }
        if (event.type === 'hello') {
          if (options.silentHello === true) return
          socket.write(
            encodeServerTextFrame(
              JSON.stringify({
                v: 1,
                id: crypto.randomUUID(),
                type: 'hello.ack',
                timestamp: Date.now(),
                payload: {
                  protocol: PROTOCOL_VERSION,
                  serverVersion: 'rig-1.0.0',
                  connectionSessionId: 'rig-session-1',
                  heartbeatIntervalMs: 30_000,
                  maxControlFrameBytes: 64 * 1024,
                  maxRelayFrameBytes: 256 * 1024,
                  capabilities: [
                    'transport.lan',
                    'transport.p2p',
                    'transport.turn',
                    'transport.relay',
                    'harness.api.v1',
                  ],
                },
              }),
            ),
          )
        } else if (event.type === 'connect.request') {
          socket.write(
            encodeServerTextFrame(
              JSON.stringify({
                v: 1,
                id: crypto.randomUUID(),
                type: 'connect.accepted',
                timestamp: Date.now(),
                payload: { connectionId: 'rig-connection-1' },
              }),
            ),
          )
        } else if (event.type === 'relay') {
          socket.write(
            encodeServerTextFrame(
              JSON.stringify({
                v: 1,
                id: crypto.randomUUID(),
                type: 'relay',
                timestamp: Date.now(),
                payload: { ...event.payload, targetDeviceId: 'rig-client' },
              }),
            ),
          )
        } else if (event.type === 'ping') {
          socket.write(
            encodeServerTextFrame(
              JSON.stringify({
                v: 1,
                id: crypto.randomUUID(),
                type: 'pong',
                timestamp: Date.now(),
                payload: event.payload,
              }),
            ),
          )
        }
      }
    })
    socket.on('error', () => undefined)
  })

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('rig listen failed')
      const url = `ws://127.0.0.1:${address.port}/ws/v1/connect`

      bridgeRig.impl = async (command: string, payload: unknown): Promise<unknown> => {
        const args = (payload as { args: Record<string, unknown> }).args
        if (command === 'bridge_connect') {
          const bridgeId = String(args.bridgeId)
          return await new Promise<undefined>((resolveBridge, rejectBridge) => {
            const raw = net.connect({ host: '127.0.0.1', port: address.port })
            let pending: Buffer = Buffer.alloc(0)
            let open = false
            const entry: BridgeEntry = {
              channel: { onmessage: undefined },
              sendFrame: text => raw.write(encodeClientTextFrame(text)),
              endSocket: () => raw.end(),
              fail: message => {
                entry.channel.onmessage?.({ event: 'Error', data: { message } })
                rejectBridge(message)
              },
            }
            connections.set(bridgeId, entry)
            raw.on('connect', () => {
              const wsKey = crypto.randomBytes(16).toString('base64')
              raw.write(
                `GET /ws/v1/connect HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${wsKey}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
              )
            })
            raw.on('data', (chunk: Buffer) => {
              pending = Buffer.concat([pending, chunk])
              if (!open) {
                const idx = pending.indexOf('\r\n\r\n')
                if (idx === -1) return
                const status = pending.subarray(0, idx).toString('utf8').split('\r\n')[0]
                if (!status?.startsWith('HTTP/1.1 101')) {
                  entry.fail(`WebSocket server returned ${status}`)
                  return
                }
                pending = pending.subarray(idx + 4)
                open = true
                entry.channel.onmessage?.({ event: 'Connected', data: null })
              }
              const { frames, rest } = decodeServerFrames(pending)
              pending = rest
              for (const frame of frames) {
                if (frame.opcode === 8) {
                  const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : null
                  const reason = frame.payload.length > 2 ? frame.payload.subarray(2).toString('utf8') : ''
                  entry.channel.onmessage?.({ event: 'Disconnected', data: { code, reason } })
                  resolveBridge(undefined)
                  return
                }
                if (frame.opcode === 1) {
                  entry.channel.onmessage?.({ event: 'Data', data: { data: frame.payload.toString('utf8') } })
                }
              }
            })
            raw.on('error', error => entry.fail(`WebSocket connection failed: ${error.message}`))
            raw.on('close', () => {
              if (!open) return
              entry.channel.onmessage?.({ event: 'Disconnected', data: { code: null, reason: 'Stream ended' } })
              resolveBridge(undefined)
            })
            // Wire the Tauri Channel (passed as onEvent) as the emit target.
            const channel = (payload as { onEvent?: { onmessage?: (event: unknown) => void } }).onEvent
            if (channel !== undefined) entry.channel = channel
          })
        }
        if (command === 'bridge_send') {
          const entry = connections.get(String(args.bridgeId))
          if (entry === undefined) throw new Error(`bridge '${String(args.bridgeId)}' is not active`)
          entry.sendFrame(String(args.data))
          return undefined
        }
        if (command === 'bridge_disconnect') {
          const entry = connections.get(String(args.bridgeId))
          if (entry !== undefined) {
            entry.endSocket()
            connections.delete(String(args.bridgeId))
          }
          return undefined
        }
        throw new Error(`bridge rig: unexpected command ${command}`)
      }

      resolve({
        url,
        upgraded: () => upgradedFlag,
        rejectWithOriginError: () => rejectWithOriginError?.(),
        close: () => server.close(),
      })
    })
  })
}

afterAll(() => {
  bridgeRig.impl = null
})

describe('TauriBridgeWebSocket ↔ vendored AdaptiveTransport (control-channel rig)', () => {
  it('completes the control handshake and a relay round trip', async () => {
    const rig = await startRig()
    try {
      const transport = new AdaptiveTransport(rig.url, {
        role: 'client',
        deviceId: 'rig-client',
        accessToken: 'rig-token',
        targetDeviceId: 'rig-host',
        forceRelay: true,
      })
      const received: Uint8Array[] = []
      transport.onMessage(data => received.push(data))
      await transport.connect()
      expect(transport.connectionInfo().connectionId).toBe('rig-connection-1')

      await transport.send(new TextEncoder().encode('rig-relay-payload'))
      await vi.waitFor(() => expect(received.length).toBeGreaterThan(0))
      expect(new TextDecoder().decode(received[0])).toBe('rig-relay-payload')

      await transport.close()
    } finally {
      rig.close()
    }
  }, 20_000)

  it('surfaces the server origin rejection through the vendored handshake', async () => {
    const rig = await startRig({ silentHello: true })
    try {
      const transport = new AdaptiveTransport(rig.url, {
        role: 'client',
        deviceId: 'rig-client',
        accessToken: 'rig-token',
        targetDeviceId: 'rig-host',
        forceRelay: true,
        handshakeTimeoutMs: 5_000,
      })
      const pending = transport.connect()
      await vi.waitFor(() => {
        if (!rig.upgraded()) throw new Error('server not upgraded yet')
      })
      rig.rejectWithOriginError()
      await expect(pending).rejects.toThrow(/origin not allowed \(WebSocket 4010\)/)
    } finally {
      rig.close()
    }
  }, 20_000)

  it('rejects instead of hanging when the bridge dial fails', async () => {
    bridgeRig.impl = async command => {
      if (command === 'bridge_connect') throw new Error('WebSocket connection failed: dns error')
      return undefined
    }
    const transport = new AdaptiveTransport('ws://127.0.0.1:9/ws/v1/connect', {
      role: 'client',
      deviceId: 'rig-client',
      accessToken: 'rig-token',
      targetDeviceId: 'rig-host',
      forceRelay: true,
      handshakeTimeoutMs: 2_000,
    })
    await expect(transport.connect()).rejects.toThrow(/dns error|failed to connect/i)
  }, 10_000)
})
