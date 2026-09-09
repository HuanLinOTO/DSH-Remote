// Secure Noise IK transport — ported from apps/android/src/services/secure-transport.ts.
// The handshake wraps the AdaptiveTransport control channel (`secure.handshake` frames);
// after completion every frame is encrypted with the Noise transport state.

import { NoiseIkSession, createNoisePrologue } from '../vendor/crypto'
import { SecureMessageCodec } from '../vendor/protocol'
import type { RemoteTransport, SecureHandshakeTransport } from '../vendor/webrtc'
import type { DeviceIdentity, RemoteDevice } from '../types'

export class SecureTransport implements RemoteTransport {
  private noise?: NoiseIkSession
  private unsubscribeInner?: () => void
  private readonly incoming = new SecureMessageCodec()
  private readonly outgoing = new SecureMessageCodec()
  private closed = false

  constructor(
    private readonly inner: SecureHandshakeTransport,
    private readonly identity: DeviceIdentity,
    private readonly host: RemoteDevice,
    private readonly onHandshakeStarting?: () => void,
  ) {
    if (host.identityKey.length === 0) throw new Error('The Host did not publish an identity key.')
  }

  async connect(): Promise<void> {
    this.closed = false
    this.incoming.reset()
    this.outgoing.reset()
    await this.inner.connect()
    const info = this.inner.connectionInfo()
    if (info.localDeviceId !== this.identity.deviceId || info.remoteDeviceId !== this.host.deviceId) {
      await this.inner.close()
      throw new Error('The relay connection was established for a different device pair.')
    }
    this.onHandshakeStarting?.()
    const noise = new NoiseIkSession({
      role: 'initiator',
      localPrivateKey: this.identity.privateKey,
      localPublicKey: this.identity.publicKey,
      remotePublicKey: this.host.identityKey,
      prologue: createNoisePrologue(info.connectionId, this.host.deviceId, this.identity.deviceId),
    })
    this.noise = noise
    try {
      await waitForResponder(this.inner, noise)
    } catch (error) {
      noise.destroy()
      this.noise = undefined
      await this.inner.close()
      throw error
    }
  }

  async send(data: Uint8Array): Promise<void> {
    const plaintextFrames = this.outgoing.encode(data)
    try {
      for (const plaintext of plaintextFrames) {
        await this.inner.send(this.requireNoise().encrypt(plaintext))
      }
    } catch (error) {
      await this.close().catch(() => undefined)
      throw error
    }
  }

  onMessage(cb: (data: Uint8Array) => void): () => void {
    this.unsubscribeInner?.()
    this.unsubscribeInner = this.inner.onMessage(data => {
      const noise = this.noise
      if (noise === undefined || !noise.complete || this.closed) return
      try {
        const message = this.incoming.decode(noise.decrypt(data))
        if (message !== undefined) cb(message)
      } catch {
        void this.close()
      }
    })
    return () => {
      this.unsubscribeInner?.()
      this.unsubscribeInner = undefined
    }
  }

  onClose(handler: () => void): () => void {
    return this.inner.onClose?.(handler) ?? (() => undefined)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.unsubscribeInner?.()
    this.unsubscribeInner = undefined
    this.incoming.reset()
    this.outgoing.reset()
    this.noise?.destroy()
    this.noise = undefined
    await this.inner.close()
  }

  getStats() { return this.inner.getStats() }

  private requireNoise(): NoiseIkSession {
    if (this.noise === undefined || !this.noise.complete || this.closed) {
      throw new Error('The secure channel is not connected.')
    }
    return this.noise
  }
}

async function waitForResponder(inner: SecureHandshakeTransport, noise: NoiseIkSession): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => finish(new Error('The secure handshake timed out.')), 10_000)
    const unsubscribe = inner.onHandshake((step, data) => {
      if (settled) return
      try {
        if (step !== 2) throw new Error('The secure handshake messages arrived out of order.')
        noise.readHandshake(data)
        if (!noise.complete) throw new Error('The secure handshake did not complete.')
        finish()
      } catch (error) {
        finish(error instanceof Error ? error : new Error('The secure handshake failed.'))
      }
    })
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubscribe()
      if (error === undefined) resolve()
      else reject(error)
    }
    void inner.sendHandshake(1, noise.writeHandshake()).catch(error => {
      finish(error instanceof Error ? error : new Error('The secure handshake failed.'))
    })
  })
}
