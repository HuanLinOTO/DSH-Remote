import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { DESKTOP_MACOS_TRAFFIC_LIGHTS_WIDTH, DESKTOP_TITLEBAR_HEIGHT, DESKTOP_TITLEBAR_Z_INDEX } from '../constants'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  FolderOpenIcon,
  SettingsIcon,
  AppWindowIcon,
  MinusIcon,
  SquareIcon,
  CopyIcon,
  CloseIcon,
} from './Icons'
import { useTranslation } from 'react-i18next'
import { useTheme } from '../hooks/useTheme'
import { getDesktopPlatform, isTauri, usesCustomDesktopTitlebar } from '../utils/tauri'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useDshStore } from '../dsh/chat/sessionStore'

/* 标题栏图标按钮通用样式 — Windows 和 macOS 视觉节奏不同，按钮尺寸分开控制 */
const TB_BTN =
  'inline-flex h-full w-8 items-center justify-center text-text-300 transition-colors hover:bg-bg-200/70 hover:text-text-100'
const TB_BTN_MAC =
  'inline-flex h-7 w-7 items-center justify-center rounded-md text-text-300 transition-colors hover:bg-bg-200/70 hover:text-text-100'

export const WindowsControls = memo(function WindowsControls() {
  const { t } = useTranslation('components')
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    let cancelled = false
    let unlistenResize: (() => void) | undefined

    const win = getCurrentWindow()
    win
      .isMaximized()
      .then(m => {
        if (!cancelled) setMaximized(m)
      })
      .catch(() => {})

    win
      .onResized(() => {
        void win
          .isMaximized()
          .then(m => {
            if (!cancelled) setMaximized(m)
          })
          .catch(() => {})
      })
      .then(fn => {
        if (cancelled) fn()
        else unlistenResize = fn
      })
      .catch(() => {})

    return () => {
      cancelled = true
      unlistenResize?.()
    }
  }, [])

  const handleMinimize = useCallback(() => {
    getCurrentWindow().minimize()
  }, [])

  const handleToggleMaximize = useCallback(() => {
    getCurrentWindow().toggleMaximize()
  }, [])

  const handleClose = useCallback(() => {
    getCurrentWindow().close()
  }, [])

  return (
    <div className="flex h-full shrink-0 items-stretch">
      <button
        type="button"
        onClick={handleMinimize}
        className={TB_BTN}
        title={t('desktopTitlebar.minimize')}
        aria-label={t('desktopTitlebar.minimize')}
      >
        <MinusIcon size={14} />
      </button>
      <button
        type="button"
        onClick={handleToggleMaximize}
        className={TB_BTN}
        title={maximized ? t('desktopTitlebar.restore') : t('desktopTitlebar.maximize')}
        aria-label={maximized ? t('desktopTitlebar.restore') : t('desktopTitlebar.maximize')}
      >
        {maximized ? <CopyIcon size={12} /> : <SquareIcon size={12} />}
      </button>
      <button
        type="button"
        onClick={handleClose}
        className={`${TB_BTN} hover:bg-danger-100 hover:text-white`}
        title={t('desktopTitlebar.close')}
        aria-label={t('desktopTitlebar.close')}
      >
        <CloseIcon size={14} />
      </button>
    </div>
  )
})

/* 连接方式徽标的状态点颜色：LAN/P2P 直连为绿，TURN/Relay 中转为琥珀，异常为红 */
const MODE_DOT_CLASS: Record<string, string> = {
  LAN: 'bg-green-500',
  P2P: 'bg-green-500',
  TURN: 'bg-amber-500',
  Relay: 'bg-amber-500',
}

/**
 * 标题栏连接徽标 —— 常驻显示当前 DSH 远程连接的方式（LAN / P2P / TURN / Relay）
 * 与往返延迟；连接建立前显示阶段文案，未连接时不渲染。
 */
export const ConnectionModeBadge = memo(function ConnectionModeBadge() {
  const { t } = useTranslation('dsh')
  const phase = useDshStore(state => state.connection.phase)
  const mode = useDshStore(state => state.connection.stats.mode)
  const rttMs = useDshStore(state => state.connection.stats.rttMs)

  if (phase === 'disconnected') return null

  const isUp = phase === 'connected'
  const dotClass = isUp
    ? MODE_DOT_CLASS[mode] ?? 'bg-green-500'
    : phase === 'offline'
      ? 'bg-red-500'
      : 'bg-yellow-500 animate-pulse'
  const label = isUp
    ? (mode === 'Disconnected' ? t('phase.connected') : rttMs !== undefined ? `${mode} · ${rttMs}ms` : mode)
    : t(`phase.${phase}`)

  return (
    <span
      className="mr-1 inline-flex shrink-0 items-center gap-1.5 rounded-full bg-bg-200/60 px-2 py-[3px] text-[11px] leading-none text-text-300"
      title={t('phase.' + phase)}
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass}`} aria-hidden />
      {label}
    </span>
  )
})

export function DesktopTitlebar() {
  const { t } = useTranslation('components')
  const { mode, resolvedTheme } = useTheme()
  const platform = useMemo(() => getDesktopPlatform(), [])
  const isDesktopChrome = useMemo(() => usesCustomDesktopTitlebar(), [])
  const titlebarButtonClass = platform === 'macos' ? TB_BTN_MAC : TB_BTN

  /* ---- 原生主题同步 ---- */
  useEffect(() => {
    if (!isDesktopChrome) return
    // 让 overlay 侧边栏知道标题栏高度
    document.documentElement.style.setProperty('--desktop-titlebar-height', `${DESKTOP_TITLEBAR_HEIGHT}px`)
    return () => {
      document.documentElement.style.removeProperty('--desktop-titlebar-height')
    }
  }, [isDesktopChrome])

  useEffect(() => {
    if (!isDesktopChrome) return

    let cancelled = false
    const theme = mode === 'system' ? null : resolvedTheme

    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      if (cancelled) return
      try {
        await getCurrentWindow().setTheme(theme)
      } catch {
        // best effort
      }
    })

    return () => {
      cancelled = true
    }
  }, [isDesktopChrome, mode, resolvedTheme])

  /* ---- 导航 ---- */
  const handleBack = useCallback(() => {
    window.history.back()
  }, [])

  const handleForward = useCallback(() => {
    window.history.forward()
  }, [])

  /* ---- 功能操作 ---- */
  const handleOpenProject = useCallback(() => {
    window.dispatchEvent(new CustomEvent('titlebar:open-project'))
  }, [])

  const handleOpenSettings = useCallback(() => {
    window.dispatchEvent(new CustomEvent('titlebar:open-settings'))
  }, [])

  const handleNewWindow = useCallback(() => {
    if (!isTauri()) return
    void import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke('open_new_window', { directory: null }).catch(() => {
        // 静默
      })
    })
  }, [])

  if (!isDesktopChrome) return null

  return (
    <header
      className="desktop-titlebar relative grid shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center bg-bg-100"
      style={{ height: DESKTOP_TITLEBAR_HEIGHT, zIndex: DESKTOP_TITLEBAR_Z_INDEX }}
    >
      {/* ---- 左侧：平台占位 + 导航 + 分隔 + 功能按钮 ---- */}
      <div className={`flex h-full shrink-0 ${platform === 'macos' ? 'items-center gap-1' : 'items-stretch'}`}>
        {platform === 'macos' ? (
          <div className="h-full shrink-0" style={{ width: DESKTOP_MACOS_TRAFFIC_LIGHTS_WIDTH }} />
        ) : (
          <div className="h-full shrink-0 w-1" />
        )}

        {/* 后退 / 前进 */}
        <button
          type="button"
          onClick={handleBack}
          className={titlebarButtonClass}
          title={t('desktopTitlebar.goBack')}
          aria-label={t('desktopTitlebar.goBack')}
        >
          <ChevronLeftIcon size={14} />
        </button>
        <button
          type="button"
          onClick={handleForward}
          className={titlebarButtonClass}
          title={t('desktopTitlebar.goForward')}
          aria-label={t('desktopTitlebar.goForward')}
        >
          <ChevronRightIcon size={14} />
        </button>

        {/* 打开项目 */}
        <button
          type="button"
          onClick={handleOpenProject}
          className={titlebarButtonClass}
          title={t('desktopTitlebar.openProject')}
          aria-label={t('desktopTitlebar.openProject')}
        >
          <FolderOpenIcon size={14} />
        </button>

        {/* 设置 */}
        <button
          type="button"
          onClick={handleOpenSettings}
          className={titlebarButtonClass}
          title={t('desktopTitlebar.openSettings')}
          aria-label={t('desktopTitlebar.openSettings')}
        >
          <SettingsIcon size={14} />
        </button>

        {/* 新建窗口 */}
        <button
          type="button"
          onClick={handleNewWindow}
          className={titlebarButtonClass}
          title={t('desktopTitlebar.newWindow')}
          aria-label={t('desktopTitlebar.newWindow')}
        >
          <AppWindowIcon size={14} />
        </button>
      </div>

      {/* ---- 中间：拖拽区 + 连接方式徽标（右侧） ---- */}
      <div data-tauri-drag-region className="flex h-full min-w-0 items-center">
        <div data-tauri-drag-region className="h-full min-w-0 flex-1" />
        <ConnectionModeBadge />
      </div>

      {/* ---- 右侧：Windows 控制按钮 / macOS 留白 ---- */}
      {platform === 'windows' ? <WindowsControls /> : <div data-tauri-drag-region className="h-full w-3 shrink-0" />}
    </header>
  )
}
