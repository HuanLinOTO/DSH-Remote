import { describe, expect, it, vi } from 'vitest'
import { RemoteServerApi } from '../api'
import { APP_VERSION } from '../../../env'
import type { DeviceIdentity } from '../../types'

const identity: DeviceIdentity = {
  deviceId: '0198abc0-1234-7abc-8123-123456789abc',
  name: 'Pixel · DSH Remote',
  platform: 'web',
  publicKey: 'A'.repeat(43),
  privateKey: 'B'.repeat(43),
}

describe('Remote Server API compatibility', () => {
  it('registers the web descriptor with the account token and validates the token pair', async () => {
    const calls: Array<{ url: string; body?: unknown; headers?: unknown }> = []
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      calls.push({ url: String(input), body: init?.body, headers: init?.headers })
      return jsonResponse(tokenPair('registered'))
    })
    const tokens = await new RemoteServerApi('https://remote.example.com', undefined, fetchImplementation)
      .registerDevice(identity, 'account-token')
    expect(tokens.accessToken).toBe('access-registered-token')
    expect(calls[0]?.url).toBe('https://remote.example.com/api/v1/devices/register')
    expect(calls[0]?.headers).toMatchObject({ Authorization: 'Bearer account-token' })
    expect(JSON.parse(String(calls[0]?.body))).toMatchObject({
      v: 1,
      device: {
        deviceId: identity.deviceId,
        role: 'client',
        platform: 'web',
        identityKey: identity.publicKey,
        clientVersion: `web-${APP_VERSION}`,
      },
    })
  })

  it('logs in with the account and returns the account session', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ email: 'user@example.com', password: 'secret' })
      expect(init?.headers).not.toMatchObject({ Authorization: expect.anything() })
      return jsonResponse({
        token: 'account-jwt-token-123456',
        expiresAt: Date.now() + 60_000,
        account: 'user@example.com',
        profile: {},
        isAdmin: false,
      })
    })
    const api = new RemoteServerApi('https://remote.example.com', undefined, fetchImplementation)
    const login = await api.loginAccount('user@example.com', 'secret')
    expect(login).toMatchObject({ token: 'account-jwt-token-123456', account: 'user@example.com', isAdmin: false })
    expect(fetchImplementation.mock.calls[0]?.[0]).toBe('https://remote.example.com/api/v1/auth/login')
  })

  it('uses Bearer auth and accepts Server device and presence shapes that omit identity keys', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async input => {
      const url = String(input)
      if (url.endsWith('/presence')) {
        return jsonResponse({ deviceId: 'host-1', online: true, lastSeenAt: 1234 })
      }
      return jsonResponse({
        items: [{
          deviceId: 'host-1', name: 'Workstation', role: 'host', platform: 'linux',
          membershipId: 'membership-1', harnessVersion: '0.1.0', lastConnectedAt: null,
        }],
        nextCursor: null,
      })
    })
    const api = new RemoteServerApi('https://remote.example.com', 'access-token-for-client', fetchImplementation)
    expect(await api.listDevices()).toEqual([expect.objectContaining({
      deviceId: 'host-1', name: 'Workstation', role: 'host', platform: 'linux',
      membershipId: 'membership-1', harnessVersion: '0.1.0',
    })])
    expect(await api.getPresence('host-1')).toEqual({ deviceId: 'host-1', online: true, lastSeenAt: 1234 })
    expect(fetchImplementation.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer access-token-for-client' })
  })

  it('fetches the authorized peer descriptor with the identity key for pinning', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => jsonResponse({
      deviceId: 'host-1', name: 'Workstation', role: 'host', platform: 'linux',
      identityKey: 'C'.repeat(43), membershipId: 'membership-1',
    }))
    const api = new RemoteServerApi('https://remote.example.com', 'access-token-for-client', fetchImplementation)
    const peer = await api.deviceFor('host-1')
    expect(peer).toMatchObject({ deviceId: 'host-1', identityKey: 'C'.repeat(43), membershipId: 'membership-1' })
    expect(fetchImplementation.mock.calls[0]?.[0]).toBe('https://remote.example.com/api/v1/devices/host-1')
  })

  it('fetches TURN credentials for the negotiated connection', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => jsonResponse({
      iceServers: [{ urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' }],
    }))
    const api = new RemoteServerApi('https://remote.example.com', 'access-token-for-client', fetchImplementation)
    const ice = await api.turnCredentials('connection-1')
    expect(ice).toEqual([{ urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' }])
    expect(fetchImplementation.mock.calls[0]?.[0]).toBe(
      'https://remote.example.com/api/v1/turn/credentials?connection_id=connection-1',
    )
  })

  it('preserves stable Server error codes and retryability', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => jsonResponse({
      error: { code: 'MEMBERSHIP_REQUIRED', message: 'membership revoked', retryable: false },
    }, 403))
    const api = new RemoteServerApi('https://remote.example.com', 'access-token-for-client', fetchImplementation)
    await expect(api.deviceFor('host-1')).rejects.toMatchObject({
      code: 'MEMBERSHIP_REQUIRED',
      status: 403,
      retryable: false,
    })
  })

  it('reports whether the server has Zhihu OAuth configured', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => jsonResponse({ configured: true }))
    const api = new RemoteServerApi('https://remote.example.com', undefined, fetchImplementation)
    await expect(api.oauthStatus()).resolves.toEqual({ configured: true })
    expect(fetchImplementation.mock.calls[0]?.[0]).toBe('https://remote.example.com/api/v1/auth/oauth/status')
  })

  it('reports whether the server has GitHub OAuth configured', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => jsonResponse({ configured: true }))
    const api = new RemoteServerApi('https://remote.example.com', undefined, fetchImplementation)
    await expect(api.oauthGithubStatus()).resolves.toEqual({ configured: true })
    expect(fetchImplementation.mock.calls[0]?.[0]).toBe('https://remote.example.com/api/v1/auth/oauth/github/status')
  })

  it('starts a QR login session scoped to the requested provider', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => jsonResponse({
      qrId: 'qr-session-id-1234567890',
      scanUrl: 'https://remote.example.com/api/v1/auth/q/qr-session-id-1234567890',
      expiresIn: 600,
      provider: 'github',
    }))
    const api = new RemoteServerApi('https://remote.example.com', undefined, fetchImplementation)
    const session = await api.startQrLogin('github')
    expect(fetchImplementation.mock.calls[0]?.[0]).toBe('https://remote.example.com/api/v1/auth/oauth/qr/start?provider=github')
    expect(session.qrId).toBe('qr-session-id-1234567890')
    expect(session.scanUrl).toBe('https://remote.example.com/api/v1/auth/q/qr-session-id-1234567890')
    expect(session.expiresIn).toBe(600)
  })

  it('rejects QR scan URLs that leave the server origin', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => jsonResponse({
      qrId: 'qr-session-id-1234567890',
      scanUrl: 'https://evil.example.com/api/v1/auth/q/xyz',
      expiresIn: 600,
    }))
    const api = new RemoteServerApi('https://remote.example.com', undefined, fetchImplementation)
    await expect(api.startQrLogin('github')).rejects.toMatchObject({ code: 'INVALID_MESSAGE' })
  })

  it('polls the QR login session until it completes with a verified account token', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async input => {
      const url = String(input)
      if (url.includes('/api/v1/auth/oauth/qr/')) return jsonResponse({ status: 'complete', token: 'one-time-account-token-1234567890' })
      expect(url).toBe('https://remote.example.com/api/v1/auth/me')
      return jsonResponse({ account: 'user@example.com' })
    })
    const api = new RemoteServerApi('https://remote.example.com', undefined, fetchImplementation)
    await expect(api.pollQrLogin('qr-session-id-1234567890')).resolves.toEqual({
      status: 'complete',
      token: 'one-time-account-token-1234567890',
      account: 'user@example.com',
    })
  })
})

function tokenPair(suffix: string) {
  return {
    accessToken: `access-${suffix}-token`,
    accessTokenExpiresAt: Date.now() + 60_000,
    refreshToken: `refresh-${suffix}-token`,
    refreshTokenExpiresAt: Date.now() + 120_000,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
