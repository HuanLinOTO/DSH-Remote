// WebSocket replacement for the DSH Remote control channel under Tauri.
//
// The WebView always attaches an Origin header (tauri://localhost /
// http://tauri.localhost) to browser WebSocket connections. The DSH Remote
// server validates the control-channel Origin (`/ws/v1/connect`) against an
// allowlist and closes unknown origins with close code 4010 "origin not
// allowed" — so the vendored AdaptiveTransport / RelayTransport could never
// finish their handshake inside the Tauri build (the official web client is
// same-origin and the Node / React-Native upstream clients send no Origin,
// which is why they are unaffected).
//
// The fix dials the control channel from Rust through the existing bridge
// commands (`bridge_connect` / `bridge_send` / `bridge_disconnect`, see
// src-tauri/src/app/commands/bridge.rs): a native tokio-tungstenite client
// that sends no Origin header, exactly like the upstream native clients.
//
// The adapter emulates the slice of the browser WebSocket API the vendored
// transports rely on: `onopen/onmessage/onerror/onclose`, `readyState`
// (+ static state constants), `binaryType` (accepted, ignored), text sends,
// and CloseEvent {code, reason} delivery so protocol errors like 4010 stay
// visible. URLs outside the DSH control channel fall through to the native
// WebSocket (dev HMR etc. keep working).

import { Channel, invoke } from '@tauri-apps/api/core'
import { isTauri } from '../../utils/tauri'

/** Rust `BridgeEvent` (serde tag = "event", content = "data"). */
type BridgeEvent =
  | { event: 'Connected'; data: null }
  | { event: 'Data'; data: { data: string } }
  | { event: 'Disconnected'; data: { code: number | null; reason: string } }
  | { event: 'Error'; data: { message: string } }

const CONTROL_CHANNEL_PATH = '/ws/v1/connect'

/** True when the URL points at the DSH Remote control WebSocket. */
export function isDshControlChannelUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return false
    return parsed.pathname.replace(/\/+$/, '') === CONTROL_CHANNEL_PATH
  } catch {
    return false
  }
}

function errorText(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Browser-WebSocket-compatible view of one Rust bridge WebSocket connection.
 * Events are dispatched asynchronously (Rust command + Channel), matching the
 * native WebSocket guarantee that handlers assigned synchronously after the
 * constructor observe every event.
 */
export class TauriBridgeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3

  binaryType: 'blob' | 'arraybuffer' = 'blob'

  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null

  private readyStateValue: number = 0
  private opened = false
  private settled = false
  private readonly bridgeId: string

  constructor(private readonly url: string) {
    bridgeCounter += 1
    this.bridgeId = `dsh-ctrl-${bridgeCounter}-${Date.now().toString(36)}`
    const channel = new Channel<BridgeEvent>()
    channel.onmessage = event => this.handleBridgeEvent(event)
    console.info(`[dsh-ws] dial ${this.bridgeId} ${this.url}`)
    void invoke('bridge_connect', {
      args: { bridgeId: this.bridgeId, url: this.url },
      onEvent: channel,
    }).then(
      () => {
        // The command resolves only after the connection loop exited; the
        // terminal event (Disconnected/Error) already arrived via the channel.
      },
      error => {
        // Dial-level failure (DNS / TLS / HTTP status): mirror the native
        // socket, which reports error + close(1006) without a close frame.
        console.warn(`[dsh-ws] dial rejected ${this.bridgeId}: ${errorText(error)}`)
        this.onerror?.({ type: 'error' })
        this.settle(1006, errorText(error), false)
      },
    )
  }

  get readyState(): number {
    return this.readyStateValue
  }

  send(data: string | ArrayBuffer | Uint8Array): void {
    if (this.readyStateValue !== 1) {
      throw new Error('WebSocket is already in CLOSING or CLOSED state')
    }
    // The bridge proxy forwards text only; DSH control frames are JSON text.
    if (typeof data !== 'string') {
      throw new Error('binary WebSocket frames are not supported by the Tauri control bridge')
    }
    void invoke('bridge_send', { args: { bridgeId: this.bridgeId, data } }).catch(error => {
      console.warn(`[dsh-ws] send failed ${this.bridgeId}: ${errorText(error)}`)
      this.onerror?.({ type: 'error' })
      this.settle(1006, errorText(error), false)
    })
  }

  close(): void {
    if (this.settled) return
    if (this.readyStateValue === 0) {
      // Native close() during CONNECTING aborts the handshake with 1006.
      this.settle(1006, '', false)
      void this.disconnect()
      return
    }
    if (this.readyStateValue === 1) {
      this.readyStateValue = 2
      // bridge_disconnect feeds Close into the Rust loop, which emits
      // Disconnected(1000, "Disconnected by client") → settle below.
      void this.disconnect()
    }
  }

  private async disconnect(): Promise<void> {
    try {
      await invoke('bridge_disconnect', { args: { bridgeId: this.bridgeId } })
    } catch {
      // Connection may already be gone; the close event was dispatched (or
      // will be by the loop's own terminal event).
    }
  }

  private handleBridgeEvent(event: BridgeEvent): void {
    switch (event.event) {
      case 'Connected': {
        if (this.settled) {
          // Client closed while the dial was still in flight; tear the
          // just-established Rust connection down again.
          console.info(`[dsh-ws] late open discarded ${this.bridgeId}`)
          void this.disconnect()
          return
        }
        console.info(`[dsh-ws] open ${this.bridgeId}`)
        this.readyStateValue = 1
        this.opened = true
        this.onopen?.({ type: 'open' })
        return
      }
      case 'Data': {
        if (!this.opened || this.settled) return
        this.onmessage?.({ data: event.data.data })
        return
      }
      case 'Disconnected': {
        const code = event.data.code ?? 1006
        console.info(`[dsh-ws] close ${this.bridgeId} code=${code} reason=${event.data.reason}`)
        this.settle(code, event.data.reason, code !== 1006)
        return
      }
      case 'Error': {
        // Rust also rejects the pending connect promise for these; settle here
        // so a missing Disconnected event cannot leave the handshake hanging.
        console.warn(`[dsh-ws] error ${this.bridgeId}: ${event.data.message}`)
        this.onerror?.({ type: 'error' })
        this.settle(1006, event.data.message, false)
        return
      }
    }
  }

  private settle(code: number, reason: string, wasClean: boolean): void {
    if (this.settled) return
    this.settled = true
    this.readyStateValue = 3
    this.opened = false
    this.onclose?.({ code, reason, wasClean })
  }
}

let bridgeCounter = 0

/**
 * Route the DSH control channel through the Rust bridge WebSocket (no Origin
 * header) while keeping the native WebSocket for everything else. Safe to
 * call in any environment: it is a no-op outside Tauri and idempotent.
 */
export function installTauriControlWebSocket(): void {
  if (!isTauri()) return
  const scope = window as typeof window & { __dshControlWebSocketInstalled?: boolean }
  if (scope.__dshControlWebSocketInstalled) return
  scope.__dshControlWebSocketInstalled = true

  const NativeWebSocket = window.WebSocket
  const BridgeWebSocket = TauriBridgeWebSocket
  const dial = function WebSocket(this: unknown, url: string | URL, protocols?: string | string[]) {
    const target = String(url)
    if (isDshControlChannelUrl(target)) {
      return new BridgeWebSocket(target) as unknown as WebSocket
    }
    return protocols === undefined ? new NativeWebSocket(target) : new NativeWebSocket(target, protocols)
  }
  const proxied = Object.assign(dial, {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
  }) as unknown as typeof WebSocket

  window.WebSocket = proxied
}
