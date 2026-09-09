import { beforeEach, describe, expect, it, vi } from 'vitest'

type TestBridgeEvent =
  | { event: 'Connected'; data: null }
  | { event: 'Data'; data: { data: string } }
  | { event: 'Disconnected'; data: { code: number | null; reason: string } }
  | { event: 'Error'; data: { message: string } }

const { invokeMock, channels } = vi.hoisted(() => ({
  invokeMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  channels: [] as Array<{ push: (event: TestBridgeEvent) => void }>,
}))

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class FakeChannel {
    onmessage?: (event: TestBridgeEvent) => void
    constructor() {
      channels.push({ push: event => this.onmessage?.(event) })
    }
  },
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

import { TauriBridgeWebSocket, installTauriControlWebSocket, isDshControlChannelUrl } from '../tauri-websocket'

function lastChannel(): { push: (event: TestBridgeEvent) => void } {
  expect(channels.length).toBeGreaterThan(0)
  return channels[channels.length - 1]!
}

beforeEach(() => {
  invokeMock.mockReset()
  invokeMock.mockResolvedValue(undefined)
  channels.length = 0
  delete (window as { __dshControlWebSocketInstalled?: boolean }).__dshControlWebSocketInstalled
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

describe('isDshControlChannelUrl', () => {
  it('matches the DSH Remote control WebSocket path on ws/wss schemes', () => {
    expect(isDshControlChannelUrl('wss://dsh.r2049.cn/ws/v1/connect')).toBe(true)
    expect(isDshControlChannelUrl('ws://10.0.0.2:8080/ws/v1/connect')).toBe(true)
  })

  it('rejects other paths, schemes, and invalid URLs', () => {
    expect(isDshControlChannelUrl('ws://localhost:1420/')).toBe(false)
    expect(isDshControlChannelUrl('wss://dsh.r2049.cn/api/v1/presence')).toBe(false)
    expect(isDshControlChannelUrl('https://dsh.r2049.cn/ws/v1/connect')).toBe(false)
    expect(isDshControlChannelUrl('not a url')).toBe(false)
  })
})

describe('TauriBridgeWebSocket', () => {
  it('dials the Rust bridge with a unique bridge id and opens on Connected', () => {
    const socket = new TauriBridgeWebSocket('wss://dsh.r2049.cn/ws/v1/connect')
    expect(socket.readyState).toBe(socket.CONNECTING)
    expect(invokeMock).toHaveBeenCalledWith('bridge_connect', {
      args: { bridgeId: expect.any(String), url: 'wss://dsh.r2049.cn/ws/v1/connect' },
      onEvent: expect.anything(),
    })

    const onOpen = vi.fn()
    socket.onopen = onOpen
    lastChannel().push({ event: 'Connected', data: null })
    expect(socket.readyState).toBe(socket.OPEN)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('delivers text frames to onmessage', () => {
    const socket = new TauriBridgeWebSocket('wss://dsh.r2049.cn/ws/v1/connect')
    const onMessage = vi.fn()
    socket.onmessage = onMessage
    lastChannel().push({ event: 'Connected', data: null })

    lastChannel().push({ event: 'Data', data: { data: '{"v":1}' } })
    expect(onMessage).toHaveBeenCalledWith({ data: '{"v":1}' })
  })

  it('maps the server close frame to a CloseEvent with code and reason', () => {
    const socket = new TauriBridgeWebSocket('wss://dsh.r2049.cn/ws/v1/connect')
    const onClose = vi.fn()
    socket.onclose = onClose
    lastChannel().push({ event: 'Connected', data: null })

    lastChannel().push({ event: 'Disconnected', data: { code: 4010, reason: 'origin not allowed' } })
    expect(socket.readyState).toBe(socket.CLOSED)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith({ code: 4010, reason: 'origin not allowed', wasClean: true })

    // Duplicate terminal events must not dispatch a second close.
    lastChannel().push({ event: 'Disconnected', data: { code: 1000, reason: '' } })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('reports dial failures as error + close(1006)', async () => {
    invokeMock.mockRejectedValueOnce('WebSocket connection failed: dns error')
    const socket = new TauriBridgeWebSocket('wss://dsh.r2049.cn/ws/v1/connect')
    const onError = vi.fn()
    const onClose = vi.fn()
    socket.onerror = onError
    socket.onclose = onClose
    await Promise.resolve()
    await Promise.resolve()

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith({
      code: 1006,
      reason: 'WebSocket connection failed: dns error',
      wasClean: false,
    })
  })

  it('settles on bridge Error events even without a Disconnected event', () => {
    const socket = new TauriBridgeWebSocket('wss://dsh.r2049.cn/ws/v1/connect')
    const onError = vi.fn()
    const onClose = vi.fn()
    socket.onerror = onError
    socket.onclose = onClose

    lastChannel().push({ event: 'Error', data: { message: 'WebSocket server returned 503' } })
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith({ code: 1006, reason: 'WebSocket server returned 503', wasClean: false })
  })

  it('sends text frames through bridge_send and rejects sends before open', () => {
    const socket = new TauriBridgeWebSocket('wss://dsh.r2049.cn/ws/v1/connect')
    lastChannel().push({ event: 'Connected', data: null })
    invokeMock.mockClear()

    socket.send('{"v":1,"type":"hello"}')
    expect(invokeMock).toHaveBeenCalledWith('bridge_send', {
      args: { bridgeId: expect.any(String), data: '{"v":1,"type":"hello"}' },
    })

    expect(() => socket.send(new ArrayBuffer(4))).toThrow(/binary/)
    const closed = new TauriBridgeWebSocket('wss://dsh.r2049.cn/ws/v1/connect')
    expect(() => closed.send('{"v":1}')).toThrow(/CLOSED/)
  })

  it('fails closed when a send is rejected by the bridge', async () => {
    const socket = new TauriBridgeWebSocket('wss://dsh.r2049.cn/ws/v1/connect')
    lastChannel().push({ event: 'Connected', data: null })
    const onClose = vi.fn()
    socket.onclose = onClose
    invokeMock.mockRejectedValueOnce("bridge 'x' is not active")

    socket.send('{"v":1}')
    await Promise.resolve()
    await Promise.resolve()
    expect(socket.readyState).toBe(socket.CLOSED)
    expect(onClose).toHaveBeenCalledWith({ code: 1006, reason: "bridge 'x' is not active", wasClean: false })
  })

  it('closes through bridge_disconnect and forwards the close frame', () => {
    const socket = new TauriBridgeWebSocket('wss://dsh.r2049.cn/ws/v1/connect')
    lastChannel().push({ event: 'Connected', data: null })
    const onClose = vi.fn()
    socket.onclose = onClose
    invokeMock.mockClear()

    socket.close()
    expect(socket.readyState).toBe(socket.CLOSING)
    expect(invokeMock).toHaveBeenCalledWith('bridge_disconnect', { args: { bridgeId: expect.any(String) } })

    lastChannel().push({ event: 'Disconnected', data: { code: 1000, reason: 'Disconnected by client' } })
    expect(socket.readyState).toBe(socket.CLOSED)
    expect(onClose).toHaveBeenCalledWith({ code: 1000, reason: 'Disconnected by client', wasClean: true })
  })

  it('aborts a dial-in-flight when closed before opening', async () => {
    const socket = new TauriBridgeWebSocket('wss://dsh.r2049.cn/ws/v1/connect')
    const onClose = vi.fn()
    socket.onclose = onClose
    invokeMock.mockClear()

    socket.close()
    expect(socket.readyState).toBe(socket.CLOSED)
    expect(onClose).toHaveBeenCalledWith({ code: 1006, reason: '', wasClean: false })
    expect(invokeMock).toHaveBeenCalledWith('bridge_disconnect', { args: { bridgeId: expect.any(String) } })

    // A late Connected after the client gave up must tear the Rust socket down.
    invokeMock.mockClear()
    lastChannel().push({ event: 'Connected', data: null })
    expect(invokeMock).toHaveBeenCalledWith('bridge_disconnect', { args: { bridgeId: expect.any(String) } })
    expect(socket.readyState).toBe(socket.CLOSED)
  })
})

describe('installTauriControlWebSocket', () => {
  class FakeNativeWebSocket {
    static readonly OPEN = 1
    constructor(
      public url: string,
      public protocols?: string | string[],
    ) {}
  }

  it('is a no-op outside Tauri', () => {
    const before = window.WebSocket
    installTauriControlWebSocket()
    expect(window.WebSocket).toBe(before)
  })

  it('routes only the control channel through the bridge and keeps native passthrough', () => {
    ;(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
    const native = FakeNativeWebSocket as unknown as typeof WebSocket
    window.WebSocket = native
    installTauriControlWebSocket()
    expect(window.WebSocket).not.toBe(native)
    expect(window.WebSocket.OPEN).toBe(1)

    const tunneled = new window.WebSocket('wss://dsh.r2049.cn/ws/v1/connect')
    expect(tunneled).toBeInstanceOf(TauriBridgeWebSocket)

    const passthrough = new window.WebSocket('ws://localhost:1420', 'vite-hmr')
    expect(passthrough).toBeInstanceOf(FakeNativeWebSocket)
    expect((passthrough as unknown as FakeNativeWebSocket).protocols).toBe('vite-hmr')

    // Idempotent: a second install must not wrap the proxy again.
    installTauriControlWebSocket()
    const again = new window.WebSocket('wss://dsh.r2049.cn/ws/v1/connect')
    expect(again).toBeInstanceOf(TauriBridgeWebSocket)
  })
})
