// Server session management — ported from apps/android/src/services/server-session-manager.ts.
// CredentialPersistence is backed by localStorage (see ./credentials).

import type { DeviceCredentials, DeviceIdentity } from '../types'
import { RemoteApiError } from '../lib/errors'
import { RemoteServerApi } from './api'

type TokenPair = Pick<DeviceCredentials, 'accessToken' | 'accessTokenExpiresAt' | 'refreshToken' | 'refreshTokenExpiresAt'>

export interface AuthenticatedServer {
  api: RemoteServerApi
  credentials: DeviceCredentials
}

export interface CredentialPersistence {
  load(serverUrl: string, deviceId: string): Promise<DeviceCredentials | undefined>
  save(credentials: DeviceCredentials): Promise<void>
}

export type ApiFactory = (baseUrl: string, accessToken?: string) => RemoteServerApi

export class ServerSessionManager {
  private readonly inFlight = new Map<string, Promise<AuthenticatedServer>>()

  constructor(
    private readonly persistence: CredentialPersistence,
    private readonly apiFactory: ApiFactory,
  ) {}

  /**
   * Log in with the account password and register (or restore) this device
   * under the account. The account token is used only for this HTTPS
   * registration and never persisted; the device token pair is stored instead.
   */
  async authenticateWithAccount(
    baseUrl: string,
    identity: DeviceIdentity,
    email: string,
    password: string,
  ): Promise<AuthenticatedServer> {
    const key = `${baseUrl}\0${identity.deviceId}`
    const pending = this.inFlight.get(key)
    if (pending !== undefined) return pending

    const created = this.authenticateWithAccountOnce(baseUrl, identity, email, password).finally(() => {
      if (this.inFlight.get(key) === created) this.inFlight.delete(key)
    })
    this.inFlight.set(key, created)
    return created
  }

  /** Register this device under a short-lived account token; the token is never persisted. */
  async registerWithAccountToken(
    baseUrl: string,
    identity: DeviceIdentity,
    accountToken: string,
    account: string,
  ): Promise<AuthenticatedServer> {
    const publicApi = this.apiFactory(baseUrl)
    const tokens = await publicApi.registerDevice(identity, accountToken)
    const credentials: DeviceCredentials = {
      serverUrl: baseUrl,
      deviceId: identity.deviceId,
      authorizationMethod: 'account',
      account,
      ...tokens,
    }
    await this.persistence.save(credentials)
    return {
      api: this.apiFactory(baseUrl, credentials.accessToken),
      credentials,
    }
  }

  authenticate(baseUrl: string, identity: DeviceIdentity): Promise<AuthenticatedServer> {
    const key = `${baseUrl}\0${identity.deviceId}`
    const pending = this.inFlight.get(key)
    if (pending !== undefined) return pending

    const created = this.authenticateOnce(baseUrl, identity).finally(() => {
      if (this.inFlight.get(key) === created) this.inFlight.delete(key)
    })
    this.inFlight.set(key, created)
    return created
  }

  private async authenticateWithAccountOnce(
    baseUrl: string,
    identity: DeviceIdentity,
    email: string,
    password: string,
  ): Promise<AuthenticatedServer> {
    const publicApi = this.apiFactory(baseUrl)
    const login = await publicApi.loginAccount(email, password)
    return this.registerWithAccountToken(baseUrl, identity, login.token, login.account)
  }

  private async authenticateOnce(baseUrl: string, identity: DeviceIdentity): Promise<AuthenticatedServer> {
    const now = Date.now()
    let credentials = await this.persistence.load(baseUrl, identity.deviceId)
    if (credentials === undefined || credentials.accessTokenExpiresAt <= now + 30_000) {
      const publicApi = this.apiFactory(baseUrl)
      let tokens: TokenPair
      if (credentials !== undefined && credentials.refreshTokenExpiresAt > now + 30_000) {
        try {
          tokens = await publicApi.refreshToken(identity.deviceId, credentials.refreshToken)
        } catch (error) {
          // 服务器已丢弃该设备的注册（今天服务器数据回滚就发生过）：保存的凭据
          // 永远无法恢复。转成 AccountRequiredError，让调用方把用户送回登录页，
          // 而不是停留在永远拿不到主机列表的界面上。
          if (isCredentialRejected(error)) {
            throw new AccountRequiredError('This browser must be authorized for this server again.')
          }
          throw error
        }
      } else {
        // No valid device credential: the user must log in again.
        throw new AccountRequiredError('This browser must be authorized for this server again.')
      }
      credentials = {
        ...credentials,
        ...tokens,
      }
      await this.persistence.save(credentials)
    }
    return {
      api: this.apiFactory(baseUrl, credentials.accessToken),
      credentials,
    }
  }
}

/** The server rejected the saved device credentials (revoked / wiped registration). */
function isCredentialRejected(error: unknown): boolean {
  if (error instanceof RemoteApiError) {
    return error.status === 401 || error.code === 'AUTH_INVALID' || error.code === 'DEVICE_REVOKED'
  }
  return false
}

export class AccountRequiredError extends Error {
  constructor(message: string) { super(message) }
}
