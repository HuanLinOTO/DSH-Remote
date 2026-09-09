// DSH connection gate: bootstrap → Login → HostList → (chat shell).
// The DSH Remote app shell renders only after a Host connection is ready.

import { useEffect, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { invoke } from '@tauri-apps/api/core'
import { useDshStore, parseOAuthReturnUrl } from '../../dsh/chat/sessionStore'
import { isTauri, isTauriMobile } from '../../utils/tauri'
import { ConnectTitlebar, LoginScreen, HostListScreen, ConnectionStatusBar } from './ConnectScreens'

/**
 * OAuth 回跳深链：浏览器授权完成后 Server 重定向 dshremote://oauth?token=…|error=…
 * 冷启动（进程被回收后由链接拉起）也能通过 getCurrent 补收。
 */
function useOAuthDeepLink() {
  const { t } = useTranslation('dsh')
  useEffect(() => {
    if (!isTauri()) return
    let disposed = false
    let unlisten: (() => void) | undefined

    const handleUrl = (url: string): void => {
      const parsed = parseOAuthReturnUrl(url)
      if (parsed === undefined) return
      if (parsed.error !== undefined) {
        // 服务端在回跳上带错误码（如 github_oauth_failed）：透传给用户定位断点
        const known: Record<string, string> = {
          oauth_failed: t('errors.zhihuOauthFailed'),
          oauth_not_configured: t('errors.zhihuUnsupported'),
          github_oauth_failed: t('errors.githubOauthFailed'),
          github_not_configured: t('errors.githubUnsupported'),
        }
        useDshStore.setState({ error: known[parsed.error] ?? t('errors.oauthCancelled', { code: parsed.error }) })
        return
      }
      const token = parsed.token
      if (token === undefined || token.length < 16) {
        useDshStore.setState({ error: t('errors.oauthInvalid') })
        return
      }
      void useDshStore.getState().completeOAuth(token)
    }

    void (async () => {
      try {
        const plugin = await import('@tauri-apps/plugin-deep-link')
        if (disposed) return
        const stop = await plugin.onOpenUrl(urls => {
          for (const url of urls) handleUrl(String(url))
        })
        if (disposed) {
          stop()
          return
        }
        unlisten = stop
        // cold start: the launch intent carries the OAuth redirect
        const initial = await plugin.getCurrent()
        if (!disposed) (initial ?? []).forEach(url => handleUrl(String(url)))
      } catch {
        // deep-link plugin unavailable (e.g. plain browser): nothing to clean up
      }
    })()

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [t])
}

export function DshGate({ children }: { children: ReactNode }) {
  const bootPhase = useDshStore(state => state.bootPhase)
  const config = useDshStore(state => state.config)
  const phase = useDshStore(state => state.connection.phase)
  const hostDescriptor = useDshStore(state => state.hostDescriptor)

  useOAuthDeepLink()

  useEffect(() => {
    void useDshStore.getState().bootstrap()
  }, [])

  // 桌面端：首帧渲染即显示窗口。不能等到 App 挂载（需已连接主机）才显示，
  // 否则登录/主机列表阶段窗口永远不可见（窗口以 visible=false 创建，等前端就绪）。
  useEffect(() => {
    if (!isTauri() || isTauriMobile()) return

    void invoke('desktop_window_ready').catch(() => {
      // best effort only
    })
  }, [])

  if (bootPhase === 'loading') {
    return (
      <div className="flex h-full w-full flex-col">
        <ConnectTitlebar />
        <div className="flex min-h-0 flex-1 items-center justify-center bg-bg-100 text-sm text-text-300">
          DSH Remote…
        </div>
      </div>
    )
  }

  if (bootPhase === 'error' || config === undefined) {
    return (
      <div className="flex h-full w-full flex-col">
        <ConnectTitlebar />
        <div className="min-h-0 flex-1">
          <LoginScreen />
        </div>
      </div>
    )
  }

  // Only a Host that was never connected falls back to the host list.
  // After the first successful connect (hostDescriptor loaded), transient
  // offline/reconnecting keeps the app shell mounted — the status bar above
  // shows the phase with retry/disconnect instead of kicking the user back
  // to device selection on every heartbeat blip.
  if (phase !== 'connected' && hostDescriptor === undefined) {
    return (
      <div className="flex h-full w-full flex-col">
        <ConnectTitlebar />
        <div className="min-h-0 flex-1">
          <HostListScreen />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full w-full flex-col">
      <ConnectionStatusBar />
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  )
}
