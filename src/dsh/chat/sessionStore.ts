// DSH session orchestration store — ported from apps/android/src/state/store.ts,
// reduced to the web client's needs (no haptics/locale/theme, single active Host).
//
// Chat items are the source of truth here; the messageStore feed is updated by
// the bridge in ./bridge.ts which subscribes to this store.

import { create } from 'zustand'
import i18n from '../../i18n'
import { messageStore } from '../../store/messageStore'
import { serverStore } from '../../store/serverStore'
import { makeSessionKey } from '../../utils/sessionKey'
import { createNativeRpcId } from '../harness/api-proxy'
import type { HarnessClient } from '../harness/client'
import { DshRemoteConnection } from '../connection/connection'
import { friendlyError, isRpcTimeoutError, RemoteApiError } from '../lib/errors'
import { initialProbeTransports, resolveAutomaticPreferredTransports } from '../lib/network-route'
import { normalizeServerUrl } from '../lib/server-url'
import {
  clearServerConfig,
  loadDeviceCredentials,
  loadIdentity,
  loadServerConfig,
  loadTransportPreference,
  saveDeviceCredentials,
  saveIdentity,
  saveServerConfig,
  saveTransportPreference,
  loadTrustedHosts,
  trustHost,
  type TransportPreference,
} from '../server/credentials'
import { createDeviceIdentity } from '../server/identity'
import { RemoteServerApi } from '../server/api'
import { AccountRequiredError, ServerSessionManager } from '../server/session-manager'
import type { DeviceCredentials } from '../types'
import type {
  ChatItem,
  ConnectionProbeTransport,
  ConnectionSnapshot,
  ConnectionStage,
  DeviceIdentity,
  DirectoryListing,
  HistoryEntry,
  HostDescriptor,
  ModelSelection,
  OAuthRedirectMethod,
  PromptImage,
  RemoteDevice,
  RemoteSession,
  ServerConfig,
  SessionModels,
  WorkspaceList,
  WorkspaceView,
} from '../types'
import { applyMuxFrameToMessages, foldHistory } from './event-reducer'

export const DEFAULT_SERVER_URL = 'https://dsh.r2049.cn'
export const REGISTER_URL = `${DEFAULT_SERVER_URL}/app/register`

/** OAuth 回跳 scheme（对齐原 Android 客户端 dshremote://oauth，Server 白名单值）。 */
export const OAUTH_RETURN_TO = 'dshremote://oauth'

/** 解析 server OAuth 回跳 URL（dshremote://oauth?token=…|error=…）；非回跳链接返回 undefined。 */
export function parseOAuthReturnUrl(url: string): { token?: string; error?: string } | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'dshremote:' || parsed.hostname !== 'oauth') return undefined
  const token = parsed.searchParams.get('token') ?? undefined
  const error = parsed.searchParams.get('error') ?? undefined
  return { ...(token !== undefined ? { token } : {}), ...(error !== undefined ? { error } : {}) }
}

type BootPhase = 'loading' | 'ready' | 'error'
type AuthPhase = 'idle' | 'authenticating' | 'complete' | 'error'

/** 一个会话的 `session.history` 向上翻页游标。 */
export interface HistoryCursor {
  /** 当前已加载窗口里最小的 event seq；下一次翻页的 beforeSeq。 */
  oldestSeq?: number
  /** Host 是否还有更早的消息。 */
  hasMore: boolean
  /** 该会话是否正在加载更早的一页。 */
  loadingOlder: boolean
}

interface DshState {
  bootPhase: BootPhase
  config?: ServerConfig
  identity?: DeviceIdentity
  account?: string
  devices: RemoteDevice[]
  selectedDevice?: RemoteDevice
  connection: ConnectionSnapshot
  connectionStage?: ConnectionStage
  connectionProbeOrder: ConnectionProbeTransport[]
  hostDescriptor?: HostDescriptor
  workspaces: WorkspaceView[]
  archivedSessionIds: string[]
  sessions: RemoteSession[]
  chatItems: Record<string, ChatItem[]>
  sessionModels?: SessionModels
  /** 每个会话各自的历史分页游标（键为裸 sessionId）——多窗格/多会话并存时不能共用一份。 */
  historyCursors: Record<string, HistoryCursor>
  transportPreference: TransportPreference
  authPhase: AuthPhase
  refreshing: boolean
  busyAction?: string
  error?: string
  /** server-issued error codes on the transport level (e.g. CONNECTION_REPLACED) */
  transportErrorCode?: string
  /** 浏览器 OAuth 授权进行中：等待 dshremote://oauth 回跳。 */
  pendingOAuth?: { baseUrl: string; method: OAuthRedirectMethod }
  /** 扫码/浏览器确认登录会话（原桌面客户端通道，无 scheme 依赖）。 */
  qrLogin?: { qrId: string; scanUrl: string; method: OAuthRedirectMethod; status: 'pending' | 'expired' }

  bootstrap(): Promise<void>
  login(input: string, email: string, password: string): Promise<boolean>
  /** 打开知乎授权（返回 start URL，由 UI 交给系统浏览器）。 */
  startOAuth(input: string): Promise<string | undefined>
  /** 打开 GitHub 授权（返回 start URL，由 UI 交给系统浏览器）。 */
  startGithubOAuth(input: string): Promise<string | undefined>
  /** OAuth 回跳带回来的账号 token → 注册本机 device。 */
  completeOAuth(token: string): Promise<boolean>
  /** 发起扫码/浏览器确认登录并开始轮询（不依赖 dshremote:// scheme）。 */
  startQrLogin(input: string, method: OAuthRedirectMethod): Promise<boolean>
  /** 取消进行中的 QR 登录轮询。 */
  cancelQrLogin(): void
  refreshDevices(): Promise<void>
  refreshWorkspaces(): Promise<void>
  connectDevice(device: RemoteDevice, options?: { forceRelay?: boolean }): Promise<boolean>
  reconnect(options?: { forceRelay?: boolean }): Promise<boolean>
  disconnect(): Promise<void>
  openSession(sessionId: string): Promise<boolean>
  createSession(workspaceId?: string): Promise<boolean>
  /** 会话重命名（Host session/rename；成功后同步 sessions 行与 messageStore 标题）。 */
  renameSession(sessionId: string, title: string): Promise<boolean>
  archiveSession(sessionId: string): Promise<boolean>
  sendMessage(sessionId: string, text: string, images?: PromptImage[]): Promise<boolean>
  stopSession(sessionId: string): Promise<void>
  respondApproval(itemId: string, outcome: 'allowed-once' | 'rejected'): Promise<void>
  respondQuestion(itemId: string, selected: Record<string, string[]>, custom?: Record<string, string>): Promise<void>
  selectModel(sessionId: string, selection: ModelSelection): Promise<boolean>
  loadOlderHistory(sessionId: string): Promise<void>
  workspaceCreate(path: string): Promise<boolean>
  hostListDirectory(path?: string): Promise<DirectoryListing | undefined>
  setTransportPreference(preference: TransportPreference): Promise<void>
  clearError(): void
  requireClient(): HarnessClient
}

const disconnected: ConnectionSnapshot = {
  phase: 'disconnected',
  stats: { mode: 'Disconnected', connected: false },
}

const connection = new DshRemoteConnection()

const persistence = {
  load: async (serverUrl: string, deviceId: string) => loadDeviceCredentials(serverUrl, deviceId),
  save: async (credentials: DeviceCredentials) => saveDeviceCredentials(credentials),
}

const sessionManager = new ServerSessionManager(persistence, (baseUrl, accessToken) => new RemoteServerApi(baseUrl, accessToken))

/** track host device per identityKey mismatch (plan §7) */
let pinnedKeyMismatch = false

export const useDshStore = create<DshState>((set, get) => ({
  bootPhase: 'loading',
  devices: [],
  connection: disconnected,
  connectionProbeOrder: [],
  workspaces: [],
  archivedSessionIds: [],
  sessions: [],
  chatItems: {},
  historyCursors: {},
  transportPreference: 'auto',
  authPhase: 'idle',
  refreshing: false,

  async bootstrap() {
    set({ bootPhase: 'loading', error: undefined })
    try {
      let identity = loadIdentity()
      if (identity === undefined) {
        identity = createDeviceIdentity()
        saveIdentity(identity)
      }
      const config = loadServerConfig()
      const transportPreference = loadTransportPreference()
      set({ identity, config, account: config?.account, transportPreference, bootPhase: 'ready' })
      if (config !== undefined) await get().refreshDevices()
    } catch (error) {
      set({ bootPhase: 'error', error: friendlyError(error) })
    }
  },

  async login(input, email, password) {
    set({ busyAction: 'login', error: undefined, authPhase: 'authenticating' })
    try {
      const identity = get().identity
      if (identity === undefined) throw new Error('Device identity is not ready yet.')
      const baseUrl = normalizeServerUrl(input)
      const { credentials } = await sessionManager.authenticateWithAccount(baseUrl, identity, email, password)
      const config: ServerConfig = { baseUrl, account: credentials.account, loginMethod: 'password' }
      saveServerConfig(config)
      set({
        config,
        account: credentials.account,
        busyAction: undefined,
        authPhase: 'complete',
        devices: [],
      })
      await get().refreshDevices()
      return true
    } catch (error) {
      set({ busyAction: undefined, authPhase: 'error', error: friendlyError(error) })
      return false
    }
  },

  /** 对齐原 startOAuth/startGithubOAuth：建公开上下文 → 校验 provider 已配置 → 记 pending → 返回 start URL。 */
  async startOAuth(input) {
    return prepareOAuthRedirect(set, get, input, 'oauth')
  },

  async startGithubOAuth(input) {
    return prepareOAuthRedirect(set, get, input, 'github-oauth')
  },

  async completeOAuth(token) {
    // 冷启动恢复：浏览器授权期间进程可能被系统回收，pending 状态只能从持久层找回。
    let pending = get().pendingOAuth
    if (pending === undefined && token.length >= 16) pending = loadPendingOAuth()
    set({ pendingOAuth: undefined })
    savePendingOAuth(undefined)
    if (pending === undefined || token.length < 16) return false
    return finishAccountLogin(set, get, pending.baseUrl, token, pending.method)
  },

  /** 对齐原 vscode 桌面客户端的 QR 通道：创建会话 + 轮询领取一次性账号 token。 */
  async startQrLogin(input, method) {
    stopQrPolling()
    set({ busyAction: 'oauth', error: undefined, authPhase: 'authenticating' })
    try {
      const identity = get().identity
      if (identity === undefined) throw new Error(t_('errors.identityNotReady'))
      const baseUrl = normalizeServerUrl(input)
      const api = new RemoteServerApi(baseUrl)
      await api.health()
      const configured = method === 'github-oauth' ? await api.oauthGithubStatus() : await api.oauthStatus()
      if (!configured.configured) throw new Error(t_(OAUTH_METHOD_UNSUPPORTED[method]))
      const session = await api.startQrLogin(method === 'github-oauth' ? 'github' : 'zhihu')
      set({
        qrLogin: { qrId: session.qrId, scanUrl: session.scanUrl, method, status: 'pending' },
        busyAction: undefined,
      })
      scheduleQrPolling(set, get, baseUrl, session.qrId, method, Date.now() + session.expiresIn * 1000)
      return true
    } catch (error) {
      set({ busyAction: undefined, error: friendlyError(error) })
      return false
    }
  },

  cancelQrLogin() {
    stopQrPolling()
    if (get().qrLogin !== undefined) set({ qrLogin: undefined, busyAction: undefined })
  },

  async refreshDevices() {
    const { config, identity } = get()
    if (config === undefined || identity === undefined) return
    set({ refreshing: true })
    try {
      const { api } = await sessionManager.authenticate(config.baseUrl, identity)
      const memberships = await api.listDevices()
      const trusted = loadTrustedHosts(config.baseUrl)
      const merged: RemoteDevice[] = []
      for (const membership of memberships) {
        const pin = trusted.find(item => item.deviceId === membership.deviceId)
        // Presence 是权威在线状态（对齐原 device-directory reconcile）：列表快照
        // 的 online 字段可能滞后，逐台查询 presence 端点作为最终判定。
        const presence = await api.getPresence(membership.deviceId).catch(() => undefined)
        merged.push({
          ...membership,
          ...(pin !== undefined ? { identityKey: pin.identityKey, trusted: true } : {}),
          online: presence?.online ?? membership.online === true,
          ...(presence?.lastSeenAt !== undefined ? { lastSeenAt: presence.lastSeenAt } : {}),
        })
      }
      set({ devices: merged, refreshing: false })
    } catch (error) {
      if (error instanceof AccountRequiredError) {
        clearServerConfig()
        set({ config: undefined, account: undefined, authPhase: 'idle', error: undefined })
      } else {
        set({ error: friendlyError(error) })
      }
      set({ refreshing: false })
    }
  },

  async refreshWorkspaces() {
    if (get().connection.phase !== 'connected') return
    try {
      const proxy = connection.requireProxy()
      const [workspaceList, sessions] = await Promise.all([
        proxy.workspaceList(),
        proxy.sessionList(),
      ])
      set(state => ({
        workspaces: workspaceList.items,
        archivedSessionIds: workspaceList.archivedSessionIds,
        sessions,
        selectedDevice: state.selectedDevice,
      }))
    } catch (error) {
      set({ error: friendlyError(error) })
    }
  },

  async connectDevice(device, options = {}) {
    const { config, identity } = get()
    if (config === undefined || identity === undefined) return false
    set({
      selectedDevice: device,
      connection: { phase: 'connecting', stats: { mode: 'Disconnected', connected: false } },
      connectionStage: 'authenticating',
      connectionProbeOrder: [],
      hostDescriptor: undefined,
      workspaces: [],
      sessions: [],
      chatItems: {},
      error: undefined,
      transportErrorCode: undefined,
    })
    try {
      // Pin the identity key: the list endpoint does not return it.
      let host = device
      if (host.identityKey.length === 0) {
        const { api } = await sessionManager.authenticate(config.baseUrl, identity)
        const peer = await api.deviceFor(device.deviceId)
        host = { ...device, identityKey: peer.identityKey, harnessVersion: peer.harnessVersion ?? device.harnessVersion }
        if (host.trusted) trustHost(config.baseUrl, host)
        set(state => ({
          devices: state.devices.map(item => item.deviceId === host.deviceId ? host : item),
          selectedDevice: host,
        }))
      }
      const { credentials } = await sessionManager.authenticate(config.baseUrl, identity)
      const preference = get().transportPreference
      const forceRelay = options.forceRelay === true || preference === 'relay'
      const preferredTransports = forceRelay
        ? ['relay'] as const
        : preference === 'turn'
          ? ['turn', 'relay'] as const
          : await resolveAutomaticPreferredTransports()
      set({ connectionStage: 'transport', connectionProbeOrder: initialProbeTransports(preferredTransports) })
      await connection.connect(
        config.baseUrl,
        identity,
        host,
        credentials.accessToken,
        frame => handleMuxFrame(set, frame),
        {
          fetchIceServers: async connectionId => {
            const { api } = await sessionManager.authenticate(config.baseUrl, identity)
            return api.turnCredentials(connectionId)
          },
          preferredTransports: [...preferredTransports],
          forceRelay,
          onSecureHandshake: () => set(state => ({
            connectionStage: 'secure',
            connection: {
              ...state.connection,
              stats: connection.getStats() ?? state.connection.stats,
            },
          })),
          onClose: () => {
            if (get().connection.phase === 'connected' || get().connection.phase === 'reconnecting') {
              set({ connection: { phase: 'offline', stats: { mode: 'Disconnected', connected: false }, error: 'The Host connection was closed.' } })
              void scheduleReconnect(set, get)
            }
          },
        },
      )
      set({ connectionStage: 'loading' })
      const proxy = connection.requireProxy()
      const [hostDescriptor, workspaceList, sessions] = await Promise.all([
        proxy.hostDescribe(),
        proxy.workspaceList(),
        proxy.sessionList(),
      ])
      set({
        hostDescriptor,
        workspaces: workspaceList.items,
        archivedSessionIds: workspaceList.archivedSessionIds,
        sessions,
        connectionStage: 'ready',
        connection: { phase: 'connected', stats: connection.getStats() ?? { mode: 'Relay', connected: true } },
      })
      return true
    } catch (error) {
      await connection.close()
      const code = (error as { code?: string } | undefined)?.code
      if (typeof code === 'string') noteTransportError(code)
      // 保存的设备凭据已被服务器拒绝：清掉本地配置，回到登录页重新注册设备，
      // 重连循环随之停止（否则会拿死凭据无限重试）。
      if (error instanceof AccountRequiredError) {
        clearServerConfig()
        set({
          config: undefined,
          account: undefined,
          authPhase: 'idle',
          error: undefined,
          connection: { phase: 'disconnected', stats: { mode: 'Disconnected', connected: false } },
        })
        return false
      }
      // 友好文案 + 原始错误详情（含 WS close code / 失败阶段），便于远程定位。
      const message = friendlyError(error)
      const raw = error instanceof Error && error.message !== message
        ? `（${error.message.slice(0, 200)}）`
        : ''
      console.error('[dsh-remote] connect failed:', error)
      set({
        connection: { phase: 'offline', stats: { mode: 'Disconnected', connected: false }, error: message + raw },
        error: message + raw,
      })
      return false
    }
  },

  async reconnect(options = {}) {
    const device = get().selectedDevice
    if (device === undefined || get().connection.phase === 'connecting') return false
    set(state => ({ connection: { ...state.connection, phase: 'reconnecting', error: undefined } }))
    return get().connectDevice(device, options)
  },

  async disconnect() {
    stopReconnectTimer()
    await connection.close()
    set({
      connection: disconnected,
      connectionStage: undefined,
      connectionProbeOrder: [],
      selectedDevice: undefined,
      hostDescriptor: undefined,
      workspaces: [],
      archivedSessionIds: [],
      sessions: [],
      chatItems: {},
      sessionModels: undefined,
      historyCursors: {},
    })
  },

  async openSession(sessionId) {
    if (sessionId === undefined || sessionId.length === 0) return false
    set({ busyAction: `session:${sessionId}`, error: undefined })
    const load = async () => {
      const history = await connection.requireProxy().sessionHistory(sessionId)
      const items = foldHistory(history.events, sessionId)
      set(state => ({
        chatItems: {
          ...state.chatItems,
          [sessionId]: items,
        },
        historyCursors: {
          ...state.historyCursors,
          [sessionId]: {
            oldestSeq: oldestSeq(history.events),
            hasMore: history.hasMore,
            loadingOlder: false,
          },
        },
        busyAction: undefined,
      }))
      void refreshSessionModels(sessionId)
    }
    try {
      await load()
      return true
    } catch (error) {
      if (isRpcTimeoutError(error)) {
        // session.history is read-only, so it is safe to recover the stale
        // path with a fresh Relay-only connection and retry exactly once.
        const recovered = await get().reconnect({ forceRelay: true })
        if (recovered) {
          try {
            await load()
            return true
          } catch (retryError) {
            set({ busyAction: undefined, error: friendlyError(retryError) })
            return false
          }
        }
        set({ busyAction: undefined })
        return false
      }
      set({ busyAction: undefined, error: friendlyError(error) })
      return false
    }
  },

  async createSession(workspaceId) {
    if (get().connection.phase !== 'connected') return false
    set({ busyAction: 'create-session', error: undefined })
    try {
      const proxy = connection.requireProxy()
      const { sessionId } = await proxy.sessionCreate(workspaceId)
      const sessions = await proxy.sessionList()
      set({ sessions, busyAction: undefined })
      const created = sessions.find(session => session.sessionId === sessionId)
      if (created !== undefined) await get().openSession(sessionId)
      return true
    } catch (error) {
      set({ busyAction: undefined, error: friendlyError(error) })
      return false
    }
  },

  async archiveSession(sessionId) {
    if (get().connection.phase !== 'connected') return false
    set({ busyAction: `archive:${sessionId}`, error: undefined })
    try {
      const proxy = connection.requireProxy()
      const archivedSessionIds = await proxy.workspaceArchiveSession(sessionId)
      const sessions = await proxy.sessionList()
      set({ archivedSessionIds, sessions, busyAction: undefined })
      return true
    } catch (error) {
      set({ busyAction: undefined, error: friendlyError(error) })
      return false
    }
  },

  async renameSession(sessionId, title) {
    const trimmed = title.trim()
    if (get().connection.phase !== 'connected' || trimmed.length === 0) return false
    try {
      const result = await connection.requireProxy().sessionRename(sessionId, trimmed)
      applySessionTitle(set, sessionId, result.title)
      return true
    } catch (error) {
      set({ error: friendlyError(error) })
      return false
    }
  },

  async sendMessage(sessionId, text, images = []) {
    const trimmed = text.trim()
    if (sessionId === undefined || sessionId.length === 0 || (trimmed.length === 0 && images.length === 0)) return false
    const session: Pick<RemoteSession, 'sessionId'> = { sessionId }
    const requestRpcId = createNativeRpcId()
    const optimistic: ChatItem = {
      kind: 'message',
      id: `local:${Date.now()}`,
      sessionId: session.sessionId,
      role: 'user',
      text: trimmed,
      ...(images.length === 0 ? {} : { images: images.map(image => ({ name: image.name })) }),
      createdAt: Date.now(),
      requestRpcId,
    }
    set(state => ({
      chatItems: {
        ...state.chatItems,
        [session.sessionId]: [...(state.chatItems[session.sessionId] ?? []), optimistic],
      },
      busyAction: 'send-message',
      error: undefined,
    }))
    try {
      await connection.requireProxy().sessionPrompt(session.sessionId, trimmed, requestRpcId, images)
      set({ busyAction: undefined })
      return true
    } catch (error) {
      set(state => ({
        chatItems: {
          ...state.chatItems,
          [session.sessionId]: (state.chatItems[session.sessionId] ?? []).filter(item => item.id !== optimistic.id),
        },
        busyAction: undefined,
        error: friendlyError(error),
      }))
      return false
    }
  },

  async stopSession(sessionId) {
    if (sessionId === undefined || sessionId.length === 0) return
    set({ busyAction: 'stop-session' })
    try {
      await connection.requireProxy().sessionCancel(sessionId)
    } catch (error) {
      set({ error: friendlyError(error) })
    } finally {
      set({ busyAction: undefined })
    }
  },

  async respondApproval(itemId, outcome) {
    set({ busyAction: `approval:${itemId}`, error: undefined })
    try {
      const proxy = connection.requireProxy()
      const item = findApproval(get().chatItems, itemId)
      if (item === undefined || item.frameRpcId === undefined) {
        throw new Error('That approval is no longer pending.')
      }
      await proxy.respondApproval(item.frameRpcId, item.sessionId, item.approvalId, outcome)
      set(state => ({
        chatItems: mapApprovalOutcome(state.chatItems, itemId, outcome),
        busyAction: undefined,
      }))
    } catch (error) {
      if (error instanceof Error && error.name === 'ApiProxyError' || (error as { code?: string })?.code === 'PERMISSION_NOT_PENDING') {
        // already answered remotely: reflect cancelled locally, no error surface
        set(state => ({
          chatItems: mapApprovalOutcome(state.chatItems, itemId, 'unavailable'),
          busyAction: undefined,
        }))
        return
      }
      set({ busyAction: undefined, error: friendlyError(error) })
    }
  },

  async respondQuestion(itemId, selected, custom) {
    set({ busyAction: `question:${itemId}`, error: undefined })
    try {
      const proxy = connection.requireProxy()
      const item = findQuestion(get().chatItems, itemId)
      if (item === undefined || item.frameRpcId === undefined) {
        throw new Error('That question is no longer pending.')
      }
      const answers = item.questions.map(question => ({
        id: question.id,
        selected: selected[question.id] ?? [],
        ...(custom?.[question.id] !== undefined ? { custom: custom[question.id] } : {}),
      }))
      await proxy.respondQuestion(item.frameRpcId, item.sessionId, { answers })
      set(state => ({
        chatItems: mapQuestionAnswered(state.chatItems, itemId),
        busyAction: undefined,
      }))
    } catch (error) {
      if ((error as { code?: string })?.code === 'PERMISSION_NOT_PENDING') {
        set(state => ({
          chatItems: mapQuestionOutcome(state.chatItems, itemId, 'cancelled'),
          busyAction: undefined,
        }))
        return
      }
      set({ busyAction: undefined, error: friendlyError(error) })
    }
  },

  async selectModel(sessionId, selection) {
    if (sessionId === undefined || sessionId.length === 0 || get().connection.phase !== 'connected') return false
    set({ busyAction: 'select-model', error: undefined })
    try {
      const selected = await connection.requireProxy().sessionSelectModel(sessionId, selection)
      set(state => ({
        sessionModels: state.sessionModels === undefined ? undefined : { ...state.sessionModels, current: selected },
        busyAction: undefined,
      }))
      return true
    } catch (error) {
      set({ busyAction: undefined, error: friendlyError(error) })
      return false
    }
  },

  async loadOlderHistory(sessionId) {
    if (sessionId === undefined || sessionId.length === 0) return
    const cursor = get().historyCursors[sessionId]
    const beforeSeq = cursor?.oldestSeq
    if (cursor === undefined || beforeSeq === undefined || cursor.loadingOlder || !cursor.hasMore) return
    set(state => ({
      historyCursors: {
        ...state.historyCursors,
        [sessionId]: { ...cursor, loadingOlder: true },
      },
    }))
    try {
      const page = await connection.requireProxy().sessionHistory(sessionId, beforeSeq, 60)
      const items = foldHistory(page.events, sessionId)
      const older = oldestSeq(page.events)
      set(state => ({
        chatItems: {
          ...state.chatItems,
          [sessionId]: prependHistory(items, state.chatItems[sessionId] ?? []),
        },
        historyCursors: {
          ...state.historyCursors,
          [sessionId]: {
            oldestSeq: older ?? state.historyCursors[sessionId]?.oldestSeq,
            hasMore: page.hasMore,
            loadingOlder: false,
          },
        },
      }))
    } catch (error) {
      set(state => ({
        historyCursors: {
          ...state.historyCursors,
          [sessionId]: {
            ...(state.historyCursors[sessionId] ?? { hasMore: false, loadingOlder: false }),
            loadingOlder: false,
          },
        },
        error: friendlyError(error),
      }))
    }
  },

  async workspaceCreate(path) {
    if (get().connection.phase !== 'connected') return false
    set({ busyAction: 'create-workspace', error: undefined })
    try {
      const proxy = connection.requireProxy()
      const { workspace } = await proxy.workspaceCreate(path)
      set(state => ({
        workspaces: [...state.workspaces.filter(item => item.workspaceId !== workspace.workspaceId), workspace],
        busyAction: undefined,
      }))
      return true
    } catch (error) {
      set({ busyAction: undefined, error: friendlyError(error) })
      return false
    }
  },

  async hostListDirectory(path) {
    if (get().connection.phase !== 'connected') return undefined
    try {
      return await connection.requireProxy().hostListDirectory(path)
    } catch (error) {
      set({ error: friendlyError(error) })
      return undefined
    }
  },

  async setTransportPreference(preference) {
    saveTransportPreference(preference)
    const wasConnected = get().connection.phase === 'connected' || get().connection.phase === 'reconnecting'
    set({ transportPreference: preference })
    if (wasConnected) await get().reconnect()
  },

  clearError() {
    set({ error: undefined })
  },

  requireClient(): HarnessClient {
    return connection.requireProxy()
  },
}))

// ============================================
// OAuth redirect login channels (port of services/login/* — oauth | github-oauth)
// ============================================

/** localized dsh-namespace string for runtime errors thrown outside React */
function t_(key: string): string {
  return i18n.t(`dsh:${key}`)
}

const PENDING_OAUTH_KEY = 'dsh-remote:pending-oauth.v1'

function savePendingOAuth(pending: { baseUrl: string; method: OAuthRedirectMethod } | undefined): void {
  try {
    if (pending === undefined) localStorage.removeItem(PENDING_OAUTH_KEY)
    else localStorage.setItem(PENDING_OAUTH_KEY, JSON.stringify(pending))
  } catch {
    // storage unavailable: the callback still works as long as the process lives
  }
}

function loadPendingOAuth(): { baseUrl: string; method: OAuthRedirectMethod } | undefined {
  try {
    const raw = localStorage.getItem(PENDING_OAUTH_KEY)
    if (raw === null) return undefined
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as { baseUrl?: unknown; method?: unknown }
    if (typeof record.baseUrl !== 'string' || (record.method !== 'oauth' && record.method !== 'github-oauth')) {
      return undefined
    }
    return { baseUrl: record.baseUrl, method: record.method }
  } catch {
    return undefined
  }
}

async function prepareOAuthRedirect(
  set: (partial: Partial<DshState> | ((state: DshState) => Partial<DshState>)) => void,
  get: () => DshState,
  input: string,
  method: OAuthRedirectMethod,
): Promise<string | undefined> {
  set({ busyAction: 'oauth', error: undefined })
  try {
    const identity = get().identity
    if (identity === undefined) throw new Error(t_('errors.identityNotReady'))
    const baseUrl = normalizeServerUrl(input)
    const api = new RemoteServerApi(baseUrl)
    await api.health()
    const configured = method === 'github-oauth' ? await api.oauthGithubStatus() : await api.oauthStatus()
    if (!configured.configured) {
      throw new Error(t_(OAUTH_METHOD_UNSUPPORTED[method]))
    }
    const pending = { baseUrl, method }
    savePendingOAuth(pending)
    set({ pendingOAuth: pending, busyAction: undefined })
    return `${baseUrl}${OAUTH_START_PATH[method]}?return_to=${encodeURIComponent(OAUTH_RETURN_TO)}`
  } catch (error) {
    set({ busyAction: undefined, error: friendlyError(error) })
    return undefined
  }
}

const OAUTH_START_PATH: Record<OAuthRedirectMethod, string> = {
  oauth: '/api/v1/auth/oauth/start',
  'github-oauth': '/api/v1/auth/oauth/github/start',
}

const OAUTH_METHOD_UNSUPPORTED: Record<OAuthRedirectMethod, string> = {
  oauth: 'errors.zhihuUnsupported',
  'github-oauth': 'errors.githubUnsupported',
}

// ============================================
// QR / 浏览器确认登录轮询（原桌面客户端通道：qr/start + 轮询领取）
// ============================================

const QR_POLL_INTERVAL_MS = 2_000

let qrPollTimer: ReturnType<typeof setTimeout> | undefined
let qrPollGeneration = 0

function stopQrPolling(): void {
  qrPollGeneration += 1
  if (qrPollTimer !== undefined) {
    clearTimeout(qrPollTimer)
    qrPollTimer = undefined
  }
}

function scheduleQrPolling(
  set: (partial: Partial<DshState> | ((state: DshState) => Partial<DshState>)) => void,
  get: () => DshState,
  baseUrl: string,
  qrId: string,
  method: OAuthRedirectMethod,
  deadline: number,
): void {
  const generation = qrPollGeneration
  const tick = async (): Promise<void> => {
    if (generation !== qrPollGeneration) return
    if (Date.now() > deadline) {
      useDshStore.setState(state => (
        state.qrLogin === undefined ? {} : { qrLogin: { ...state.qrLogin, status: 'expired' } }
      ))
      return
    }
    try {
      const api = new RemoteServerApi(baseUrl)
      const poll = await api.pollQrLogin(qrId)
      if (generation !== qrPollGeneration) return
      if (poll.status === 'complete') {
        set({ qrLogin: undefined, busyAction: undefined })
        await finishAccountLogin(set, get, baseUrl, poll.token, method)
        return
      }
      if (poll.status === 'expired') {
        set(state => ({ qrLogin: state.qrLogin === undefined ? undefined : { ...state.qrLogin, status: 'expired' }, busyAction: undefined }))
        return
      }
      // pending：继续轮询，直到授权完成或超出服务端会话有效期。
      qrPollTimer = setTimeout(() => { void tick() }, QR_POLL_INTERVAL_MS)
    } catch {
      // 单次轮询失败不终止流程（网络抖动/超时），放缓节奏继续等。
      const qr = get().qrLogin
      if (qr === undefined || qr.status !== 'pending') return
      qrPollTimer = setTimeout(() => { void tick() }, QR_POLL_INTERVAL_MS * 2)
    }
  }
  void tick()
}

/** 登录完成共享路径：核验账号 token → 注册本机 device → 持久化配置。 */
async function finishAccountLogin(
  set: (partial: Partial<DshState> | ((state: DshState) => Partial<DshState>)) => void,
  get: () => DshState,
  inputBaseUrl: string,
  token: string,
  method: OAuthRedirectMethod,
): Promise<boolean> {
  set({ busyAction: 'server', error: undefined, authPhase: 'authenticating' })
  try {
    if (get().identity === undefined) await get().bootstrap()
    const identity = get().identity
    if (identity === undefined) throw new Error(t_('errors.identityNotReady'))
    const baseUrl = normalizeServerUrl(inputBaseUrl)
    const api = new RemoteServerApi(baseUrl)
    const profile = await api.accountMe(token)
    const { credentials } = await sessionManager.registerWithAccountToken(baseUrl, identity, token, profile.account)
    const config: ServerConfig = { baseUrl, account: credentials.account ?? profile.account, loginMethod: method }
    saveServerConfig(config)
    set({
      config,
      account: credentials.account,
      busyAction: undefined,
      authPhase: 'complete',
      devices: [],
    })
    await get().refreshDevices()
    return true
  } catch (error) {
    set({ busyAction: undefined, authPhase: 'error', error: friendlyError(error) })
    return false
  }
}

// ============================================
// Reconnect with exponential backoff (plan §5.4 / §7)
// ============================================

let reconnectTimer: ReturnType<typeof setTimeout> | undefined
let reconnectAttempt = 0

function stopReconnectTimer(): void {
  if (reconnectTimer !== undefined) {
    clearTimeout(reconnectTimer)
    reconnectTimer = undefined
  }
}

async function scheduleReconnect(
  set: (partial: Partial<DshState> | ((state: DshState) => Partial<DshState>)) => void,
  get: () => DshState,
): Promise<void> {
  if (get().config === undefined) return
  if (get().transportErrorCode === 'CONNECTION_REPLACED') return
  const device = get().selectedDevice
  if (device === undefined) return
  stopReconnectTimer()
  const delay = Math.min(30_000, 1000 * 2 ** reconnectAttempt)
  reconnectAttempt += 1
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined
    if (get().selectedDevice === undefined) return
    if (get().connection.phase === 'connected') return
    void get().reconnect().then(ok => {
      if (ok) reconnectAttempt = 0
      else if (get().connection.phase === 'offline') void scheduleReconnect(set, get)
    })
  }, delay)
}

// WebView 切后台时定时器会被浏览器重度节流（长时间后台可到分钟级），退避重连
// 被无限推迟 —— 表现为回到前台后连接不恢复、主机一直"不在线"。回前台时若处于
// offline 且仍有选中设备，立即补一次重连尝试。
let visibilityReconnectInFlight = false

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    const state = useDshStore.getState()
    if (state.config === undefined) return
    if (state.selectedDevice === undefined) return
    if (state.connection.phase !== 'offline' && state.connection.phase !== 'reconnecting') return
    if (visibilityReconnectInFlight) return
    visibilityReconnectInFlight = true
    stopReconnectTimer()
    void state
      .reconnect()
      .catch(() => false)
      .then(ok => {
        visibilityReconnectInFlight = false
        if (ok) reconnectAttempt = 0
        else if (useDshStore.getState().connection.phase === 'offline') {
          void scheduleReconnect(useDshStore.setState, useDshStore.getState)
        }
      })
  })
}

function noteTransportError(code: unknown): void {
  if (typeof code === 'string' && code.length > 0) {
    useDshStore.setState({ transportErrorCode: code })
    if (code === 'CONNECTION_REPLACED') stopReconnectTimer()
  }
  if (typeof code === 'string' && code === 'PEER_IDENTITY_MISMATCH') pinnedKeyMismatch = true
}

export function hasPinnedKeyMismatch(): boolean {
  return pinnedKeyMismatch
}

export function acknowledgePinnedKeyMismatch(): void {
  pinnedKeyMismatch = false
}

// ============================================
// Frame routing / helpers
// ============================================

function handleMuxFrame(
  set: (partial: Partial<DshState> | ((state: DshState) => Partial<DshState>)) => void,
  frame: import('../types').MuxStreamFrame,
): void {
  if (frame.payload.type === 'stream/closed') {
    noteTransportError((frame.payload as { error?: { code?: string } }).error?.code)
  }
  // Host LLM 生成的会话标题（session/control 的 title 投影）→ 立即更新会话行，
  // 否则标题要等到下一次 session.list（重连/新建会话）才会出现。
  if (frame.payload.type === 'session/renamed') {
    const { sessionId, title } = frame.payload
    if (typeof sessionId === 'string' && typeof title === 'string' && title.length > 0) {
      applySessionTitle(set, sessionId, title)
    }
    return
  }
  set(state => {
    const chatItems = applyMuxFrameToMessages(state.chatItems, frame)
    // 未产生新对象（遥测帧 / 幂等帧）时不触发任何订阅者
    return chatItems === state.chatItems ? state : { chatItems }
  })
}

/** 标题变更落到 sessions 行 + messageStore 元数据（Header 读取的是 messageStore）。 */
function applySessionTitle(
  set: (partial: Partial<DshState> | ((state: DshState) => Partial<DshState>)) => void,
  sessionId: string,
  title: string,
): void {
  let applied = false
  set(state => {
    const index = state.sessions.findIndex(entry => entry.sessionId === sessionId)
    if (index === -1 || state.sessions[index].title === title) return state
    const sessions = [...state.sessions]
    sessions[index] = { ...sessions[index], title }
    applied = true
    return { sessions }
  })
  if (applied) {
    messageStore.updateSessionMetadata(makeSessionKey(serverStore.getActiveServerId(), sessionId), { title })
  }
}

async function refreshSessionModels(sessionId: string): Promise<void> {
  try {
    const models = await connection.requireProxy().sessionModels(sessionId)
    useDshStore.setState({ sessionModels: models })
  } catch {
    // ignored: the chat stays usable without a model catalog
  }
}

function findApproval(messages: Record<string, ChatItem[]>, itemId: string) {
  for (const items of Object.values(messages)) {
    const found = items.find(item => item.kind === 'approval' && item.id === itemId)
    if (found !== undefined && found.kind === 'approval') return found
  }
  return undefined
}

function findQuestion(messages: Record<string, ChatItem[]>, itemId: string) {
  for (const items of Object.values(messages)) {
    const found = items.find(item => item.kind === 'question' && item.id === itemId)
    if (found !== undefined && found.kind === 'question') return found
  }
  return undefined
}

function mapApprovalOutcome(
  messages: Record<string, ChatItem[]>,
  itemId: string,
  outcome: 'allowed-once' | 'rejected' | 'unavailable',
): Record<string, ChatItem[]> {
  return mapItems(messages, item => item.kind === 'approval' && item.id === itemId
    ? { ...item, outcome }
    : item)
}

function mapQuestionAnswered(
  messages: Record<string, ChatItem[]>,
  itemId: string,
): Record<string, ChatItem[]> {
  return mapQuestionOutcome(messages, itemId, 'answered')
}

function mapQuestionOutcome(
  messages: Record<string, ChatItem[]>,
  itemId: string,
  outcome: 'answered' | 'cancelled',
): Record<string, ChatItem[]> {
  return mapItems(messages, item => item.kind === 'question' && item.id === itemId
    ? { ...item, outcome }
    : item)
}

function mapItems(
  messages: Record<string, ChatItem[]>,
  map: (item: ChatItem) => ChatItem,
): Record<string, ChatItem[]> {
  return Object.fromEntries(Object.entries(messages).map(([sessionId, items]) => [sessionId, items.map(map)]))
}

/** Prepend an older history page in front of the current chat items, deduplicated by id. */
function prependHistory(older: ChatItem[], current: ChatItem[]): ChatItem[] {
  const currentIds = new Set(current.map(item => item.id))
  return [...older.filter(item => !currentIds.has(item.id)), ...current]
}

/** Smallest event seq in a history page; drives the next `session.history` beforeSeq. */
function oldestSeq(events: HistoryEntry[]): number | undefined {
  let oldest: number | undefined
  for (const entry of events) {
    const seq = entry.event.seq
    if (Number.isSafeInteger(seq)) oldest = oldest === undefined ? seq : Math.min(oldest, seq)
  }
  return oldest
}

export type { WorkspaceList }
export { RemoteApiError }
