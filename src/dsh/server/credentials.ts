// Credential & preference persistence for the web client.
// localStorage replaces Expo SecureStore (plan D7): namespace `dsh-remote:<serverUrl|*>:<key>`.

import type { DeviceCredentials, DeviceIdentity, RemoteDevice, ServerConfig } from '../types'

const KEYS = {
  config: 'dsh-remote:server.v1',
  identity: 'dsh-remote:identity.v1',
  credentials: (serverUrl: string) => `dsh-remote:${serverUrl}:credentials.v1`,
  trustedHosts: (serverUrl: string) => `dsh-remote:${serverUrl}:trusted-hosts.v1`,
  transportPreference: 'dsh-remote:transport-preference.v1',
} as const

function readJson<T>(key: string): T | undefined {
  try {
    const value = localStorage.getItem(key)
    if (value === null) return undefined
    return JSON.parse(value) as T
  } catch {
    try {
      localStorage.removeItem(key)
    } catch {
      // ignore
    }
    return undefined
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // storage full/unavailable: credentials simply stay in memory for this session
  }
}

function remove(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

export function loadServerConfig(): ServerConfig | undefined {
  return readJson<ServerConfig>(KEYS.config)
}

export function saveServerConfig(config: ServerConfig): void {
  writeJson(KEYS.config, config)
}

export function clearServerConfig(): void {
  remove(KEYS.config)
}

export function loadIdentity(): DeviceIdentity | undefined {
  return readJson<DeviceIdentity>(KEYS.identity)
}

export function saveIdentity(identity: DeviceIdentity): void {
  writeJson(KEYS.identity, identity)
}

export function loadDeviceCredentials(serverUrl: string, deviceId: string): DeviceCredentials | undefined {
  const credentials = readJson<DeviceCredentials>(KEYS.credentials(serverUrl))
  return credentials?.serverUrl === serverUrl && credentials.deviceId === deviceId ? credentials : undefined
}

export function saveDeviceCredentials(credentials: DeviceCredentials): void {
  writeJson(KEYS.credentials(credentials.serverUrl), credentials)
}

export function clearDeviceCredentials(serverUrl: string): void {
  remove(KEYS.credentials(serverUrl))
}

export function loadTrustedHosts(serverUrl: string): RemoteDevice[] {
  const stored = readJson<Array<RemoteDevice & { publicKey?: string }>>(KEYS.trustedHosts(serverUrl)) ?? []
  return stored.flatMap(host => {
    const identityKey = host.identityKey ?? host.publicKey
    if (identityKey === undefined || identityKey.length === 0) return []
    return [{ ...host, identityKey }]
  })
}

export function trustHost(serverUrl: string, host: RemoteDevice): void {
  const hosts = loadTrustedHosts(serverUrl)
  writeJson(KEYS.trustedHosts(serverUrl), [
    ...hosts.filter(item => item.deviceId !== host.deviceId),
    { ...host, trusted: true },
  ])
}

export function forgetHost(serverUrl: string, deviceId: string): void {
  const hosts = loadTrustedHosts(serverUrl)
  writeJson(KEYS.trustedHosts(serverUrl), hosts.filter(host => host.deviceId !== deviceId))
}

export type TransportPreference = 'auto' | 'turn' | 'relay'

export function loadTransportPreference(): TransportPreference {
  const stored = readJson<{ value: TransportPreference }>(KEYS.transportPreference)
  if (stored?.value === 'turn' || stored?.value === 'relay') return stored.value
  return 'auto'
}

export function saveTransportPreference(value: TransportPreference): void {
  writeJson(KEYS.transportPreference, { value })
}

export function clearLocalData(serverUrl?: string): void {
  clearServerConfig()
  remove(KEYS.identity)
  remove(KEYS.transportPreference)
  if (serverUrl !== undefined) {
    clearDeviceCredentials(serverUrl)
    remove(KEYS.trustedHosts(serverUrl))
  }
}
