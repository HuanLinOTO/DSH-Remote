// DSH connection UI: Login → Host list → (workspace) → chat gate.
// Plan §5.4 补充：LoginScreen / HostListScreen / ConnectionStatusBar / WorkspacePicker.
// 登录方式对齐原 Android 客户端 setup-screens：知乎 OAuth / GitHub OAuth / 邮箱密码。

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDshStore, DEFAULT_SERVER_URL, REGISTER_URL } from '../../dsh/chat/sessionStore'
import type { OAuthRedirectMethod } from '../../dsh/types'
import { identityFingerprint } from '../../dsh/vendor/crypto'
import type { RemoteDevice } from '../../dsh/types'
import { Button } from '../../components/ui/Button'
import { Input } from './primitives'
import { openExternalUrl } from '../../utils/openExternal'
import { WindowsControls } from '../../components/DesktopTitlebar'
import { DESKTOP_MACOS_TRAFFIC_LIGHTS_WIDTH, DESKTOP_TITLEBAR_HEIGHT } from '../../constants'
import { getDesktopPlatform, usesCustomDesktopTitlebar } from '../../utils/tauri'

type LoginTab = OAuthRedirectMethod | 'password'

const LOGIN_TABS: readonly LoginTab[] = ['oauth', 'github-oauth', 'password'] as const

// ============================================
// Connect-stage titlebar（无装饰窗口的拖拽区 + Windows 窗口控制）
// ============================================

export function ConnectTitlebar() {
  const platform = useMemo(() => getDesktopPlatform(), [])
  if (!usesCustomDesktopTitlebar()) return null

  return (
    <header className="flex shrink-0 items-stretch bg-bg-100" style={{ height: DESKTOP_TITLEBAR_HEIGHT }}>
      {platform === 'macos' && (
        <div className="h-full shrink-0" style={{ width: DESKTOP_MACOS_TRAFFIC_LIGHTS_WIDTH }} />
      )}
      <div data-tauri-drag-region className="h-full min-w-0 flex-1" />
      {platform === 'windows' && <WindowsControls />}
    </header>
  )
}

// ============================================
// Login
// ============================================

export function LoginScreen() {
  const { t } = useTranslation('dsh')
  const login = useDshStore(state => state.login)
  const startOAuth = useDshStore(state => state.startOAuth)
  const startGithubOAuth = useDshStore(state => state.startGithubOAuth)
  const startQrLogin = useDshStore(state => state.startQrLogin)
  const cancelQrLogin = useDshStore(state => state.cancelQrLogin)
  const qrLogin = useDshStore(state => state.qrLogin)
  const busyAction = useDshStore(state => state.busyAction)
  const error = useDshStore(state => state.error)
  const clearError = useDshStore(state => state.clearError)

  const [server, setServer] = useState(DEFAULT_SERVER_URL)
  const [method, setMethod] = useState<LoginTab>('oauth')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const busy = busyAction === 'login' || busyAction === 'server' || busyAction === 'oauth'

  const submit = useCallback(async (event: React.FormEvent) => {
    event.preventDefault()
    await login(server, email, password)
  }, [login, server, email, password])

  /** 对齐原 setup-screens：prepare redirect → 系统浏览器打开授权页。 */
  const signInWithRedirect = useCallback(async (redirectMethod: OAuthRedirectMethod) => {
    const url = redirectMethod === 'github-oauth' ? await startGithubOAuth(server) : await startOAuth(server)
    if (url !== undefined) await openExternalUrl(url)
  }, [server, startOAuth, startGithubOAuth])

  return (
    <div className="flex h-full w-full items-center justify-center overflow-y-auto bg-bg-100 p-6">
      <form onSubmit={submit} className="w-full max-w-sm my-auto rounded-xl border border-border-200/60 bg-bg-000 p-6 shadow-float">
        <h1 className="mb-1 text-lg font-semibold text-text-100">{t('login.title')}</h1>
        <p className="mb-5 text-sm text-text-300">{t('login.subtitle')}</p>

        <div className="mb-4 flex gap-1 rounded-lg bg-bg-200/70 p-1" role="tablist">
          {LOGIN_TABS.map(tab => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={method === tab}
              onClick={() => setMethod(tab)}
              className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                method === tab
                  ? 'bg-bg-000 text-text-100 shadow-sm'
                  : 'text-text-300 hover:text-text-100'
              }`}
            >
              {t(`login.method${tab === 'oauth' ? 'Zhihu' : tab === 'github-oauth' ? 'Github' : 'Password'}`)}
            </button>
          ))}
        </div>

        {(method === 'oauth' || method === 'github-oauth') && (
          <div className="flex flex-col gap-3">
            <Button
              type="button"
              className="w-full"
              disabled={busyAction !== undefined || qrLogin !== undefined}
              onClick={() => void signInWithRedirect(method)}
            >
              {busyAction === 'oauth' ? t('login.signingIn') : method === 'oauth' ? t('login.signInZhihu') : t('login.signInGithub')}
            </Button>
            <p className="text-center text-xs text-text-400">{t('login.oauthHint')}</p>

            {/* QR/浏览器确认通道（原桌面客户端通道）：不受 dshremote:// scheme 冲突影响 */}
            <div className="flex flex-col gap-2 border-t border-border-200/60 pt-3">
              {qrLogin === undefined ? (
                <>
                  <button
                    type="button"
                    className="w-full rounded-md border border-border-200/60 bg-bg-100 px-3 py-1.5 text-sm font-medium text-text-100 transition-colors hover:bg-bg-200 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={busyAction !== undefined}
                    onClick={() => void startQrLogin(server, method)}
                  >
                    {t('login.qrTitle')}
                  </button>
                  <p className="text-center text-xs text-text-400">{t('login.qrHint')}</p>
                </>
              ) : qrLogin.status === 'pending' ? (
                <>
                  <p className="flex items-center justify-center gap-2 text-center text-xs text-text-200">
                    <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-yellow-500" aria-hidden />
                    {t('login.qrWaiting')}
                  </p>
                  <div className="flex gap-2">
                    <Button type="button" className="flex-1" onClick={() => void openExternalUrl(qrLogin.scanUrl)}>
                      {t('login.qrOpenPage')}
                    </Button>
                    <button
                      type="button"
                      className="flex-1 rounded-md border border-border-200/60 px-3 py-1.5 text-sm text-text-200 transition-colors hover:bg-bg-200"
                      onClick={cancelQrLogin}
                    >
                      {t('login.qrCancel')}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-center text-xs text-red-400">{t('login.qrExpired')}</p>
                  <Button type="button" className="w-full" onClick={() => void startQrLogin(server, method)}>
                    {t('login.qrRetry')}
                  </Button>
                </>
              )}
            </div>
          </div>
        )}
        {method === 'password' && (
          <div className="flex flex-col">
            <label className="mb-3 block">
              <span className="mb-1 block text-xs font-medium text-text-200">{t('login.email')}</span>
              <Input value={email} onChange={setEmail} type="email" autoComplete="email" required />
            </label>
            <label className="mb-4 block">
              <span className="mb-1 block text-xs font-medium text-text-200">{t('login.password')}</span>
              <Input value={password} onChange={setPassword} type="password" autoComplete="current-password" required />
            </label>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? t('login.signingIn') : t('login.signIn')}
            </Button>
          </div>
        )}

        {error !== undefined && error.length > 0 && (
          <p className="mt-3 rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-400" onClick={clearError}>
            {error}
          </p>
        )}

        <label className="mt-4 block">
          <span className="mb-1 block text-xs font-medium text-text-200">{t('login.server')}</span>
          <Input value={server} onChange={setServer} placeholder={DEFAULT_SERVER_URL} autoComplete="url" />
        </label>

        <p className="mt-4 text-center text-xs text-text-400">
          {t('login.noAccount')}{' '}
          <a href={REGISTER_URL} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">
            {t('login.register')}
          </a>
        </p>
      </form>
    </div>
  )
}

// ============================================
// Host list
// ============================================

function presenceLabel(device: RemoteDevice): string {
  if (!device.online) return 'offline'
  return device.harnessVersion ?? device.clientVersion ?? 'online'
}

export function HostListScreen({ onConnected }: { onConnected?: () => void }) {
  const { t } = useTranslation('dsh')
  const devices = useDshStore(state => state.devices)
  const refreshing = useDshStore(state => state.refreshing)
  const refreshDevices = useDshStore(state => state.refreshDevices)
  const connectDevice = useDshStore(state => state.connectDevice)
  const connection = useDshStore(state => state.connection)
  const account = useDshStore(state => state.account)
  const selectedDeviceId = useDshStore(state => state.selectedDevice?.deviceId)

  useEffect(() => {
    void refreshDevices()
    const timer = window.setInterval(() => {
      void refreshDevices()
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [refreshDevices])

  useEffect(() => {
    if (connection.phase === 'connected') onConnected?.()
  }, [connection.phase, onConnected])

  const connecting = connection.phase === 'connecting' || connection.phase === 'reconnecting'

  return (
    <div className="flex h-full w-full items-start justify-center overflow-y-auto bg-bg-100 p-6">
      {/* my-auto：有富余空间时垂直居中，内容超高时 margin 归零、从顶部正常滚动（避免 items-center 裁顶） */}
      <div className="w-full max-w-md my-auto">
        <div className="mb-4 flex items-baseline justify-between">
          <h1 className="text-lg font-semibold text-text-100">{t('hosts.title')}</h1>
          <span className="text-xs text-text-400">{account ?? ''}</span>
        </div>

        {devices.length === 0 && (
          <div className="rounded-lg border border-border-200/60 bg-bg-000 p-6 text-center text-sm text-text-300">
            {refreshing ? t('hosts.loading') : t('hosts.empty')}
          </div>
        )}

        <ul className="flex flex-col gap-2">
          {devices.map(device => (
            <li
              key={device.deviceId}
              className="flex items-center justify-between rounded-lg border border-border-200/60 bg-bg-000 px-4 py-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-block h-2 w-2 shrink-0 rounded-full ${device.online ? 'bg-green-500' : 'bg-gray-500'}`}
                    aria-hidden
                  />
                  <span className="truncate text-sm font-medium text-text-100">{device.name}</span>
                </div>
                <div className="mt-0.5 pl-4 text-xs text-text-400">
                  {device.platform} · {presenceLabel(device)}
                  {device.identityKey.length > 0 && (
                    <> · <span title={t('hosts.fingerprint')}>{identityFingerprint(device.identityKey)}</span></>
                  )}
                </div>
              </div>
              <Button
                onClick={() => void connectDevice(device)}
                disabled={!device.online || connecting}
                className="shrink-0"
              >
                {selectedDeviceId === device.deviceId && connecting
                  ? t('hosts.connecting')
                  : t('hosts.connect')}
              </Button>
            </li>
          ))}
        </ul>

        {connection.phase === 'offline' && connection.error !== undefined && (
          <p className="mt-4 rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-400">{connection.error}</p>
        )}

        <div className="mt-4 flex items-center justify-between text-xs text-text-400">
          <button type="button" className="hover:text-text-200" onClick={() => void refreshDevices()}>
            {t('hosts.refresh')}
          </button>
          <button
            type="button"
            className="hover:text-text-200"
            onClick={() => {
              const store = useDshStore.getState()
              store.disconnect().then(() => {
                // sign-out returns to the login screen
              })
            }}
          >
            {t('hosts.signOut')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ============================================
// Connection status bar (phase / stage / transport / rtt)
// ============================================

export function ConnectionStatusBar() {
  const { t } = useTranslation('dsh')
  const connection = useDshStore(state => state.connection)
  const stage = useDshStore(state => state.connectionStage)
  const hostDescriptor = useDshStore(state => state.hostDescriptor)
  const reconnect = useDshStore(state => state.reconnect)
  const disconnect = useDshStore(state => state.disconnect)

  if (connection.phase === 'disconnected') return null

  const phaseLabel = stage !== undefined ? t(`status.${stage}`) : t(`phase.${connection.phase}`)
  const transport = connection.stats.mode
  const rtt = connection.stats.rttMs !== undefined ? ` · ${connection.stats.rttMs}ms` : ''
  const isError = connection.phase === 'offline'

  return (
    <div
      className={`flex items-center gap-2 px-4 py-1 text-xs ${
        isError ? 'bg-red-500/10 text-red-400' : 'bg-bg-200/60 text-text-300'
      }`}
    >
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${
          connection.phase === 'connected' ? 'bg-green-500' : isError ? 'bg-red-500' : 'bg-yellow-500 animate-pulse'
        }`}
        aria-hidden
      />
      <span>{phaseLabel}</span>
      <span className="text-text-400">· {transport}{rtt}</span>
      {hostDescriptor !== undefined && (
        <span className="truncate text-text-400">· {hostDescriptor.cwd} · {hostDescriptor.version}</span>
      )}
      <span className="flex-1" />
      {isError && (
        <>
          <button type="button" className="hover:text-text-100" onClick={() => void reconnect()}>
            {t('status.retry')}
          </button>
          <button type="button" className="hover:text-text-100" onClick={() => void disconnect()}>
            {t('hosts.disconnect')}
          </button>
        </>
      )}
    </div>
  )
}

// ============================================
// Workspace picker (inline in sidebar via directory context)
// ============================================

export function WorkspacePicker({ onPick }: { onPick: (path: string) => void }) {
  const { t } = useTranslation('dsh')
  const workspaces = useDshStore(state => state.workspaces)
  const hostDescriptor = useDshStore(state => state.hostDescriptor)

  return (
    <select
      className="w-full rounded-md border border-border-200/60 bg-bg-000 px-2 py-1 text-xs text-text-200"
      defaultValue=""
      onChange={event => {
        if (event.target.value.length > 0) onPick(event.target.value)
      }}
      aria-label={t('workspace.pick')}
    >
      <option value="">{workspaces.length > 0 ? t('workspace.pick') : hostDescriptor?.cwd || t('workspace.empty')}</option>
      {workspaces.map(workspace => (
        <option key={workspace.workspaceId} value={workspace.path}>
          {workspace.title || workspace.path}
        </option>
      ))}
    </select>
  )
}
