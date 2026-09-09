// Device identity for DSH Remote — web adaptation of apps/android storage identity helpers.
// Uses the vendored X25519 key generation (WebCrypto randomness via @noble/ciphers/webcrypto).

import { generateKeyPair } from '../vendor/crypto'
import type { DeviceIdentity } from '../types'

function deviceName(): string {
  try {
    const ua = navigator.userAgent
    const browser = /Edg\//.test(ua)
      ? 'Edge'
      : /OPR\//.test(ua)
        ? 'Opera'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Chrome\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : 'Browser'
    return `Web · ${browser}`
  } catch {
    return 'Web · DSH Remote'
  }
}

export function createDeviceIdentity(): DeviceIdentity {
  const privateKeyBytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(privateKeyBytes)
  const keyPair = generateKeyPair(privateKeyBytes)
  return {
    deviceId: globalThis.crypto.randomUUID(),
    name: deviceName(),
    platform: 'web',
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
  }
}
