// RightPanel — DSH Host information panel (replaces the OpenCode file/diff/terminal tabs).
// Shows the connected Host descriptor, workspaces, and live transport stats.

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLayoutStore, layoutStore } from '../store/layoutStore'
import { useDshStore } from '../dsh/chat/sessionStore'
import { ResizablePanel } from './ui/ResizablePanel'
import { WorkspacePicker } from '../features/connect/ConnectScreens'
import { useDirectory } from '../hooks'
import { normalizeToForwardSlash } from '../utils'

interface RightPanelProps {
  directory?: string
  sessionId?: string | null
  serverId?: string
  inline?: boolean
  renderPanelContent?: boolean
}

export function RightPanel({ inline = false, renderPanelContent = true }: RightPanelProps) {
  const { t } = useTranslation('dsh')
  const { rightPanelOpen, rightPanelWidth } = useLayoutStore()
  const { setCurrentDirectory } = useDirectory()
  const hostDescriptor = useDshStore(state => state.hostDescriptor)
  const workspaces = useDshStore(state => state.workspaces)
  const sessions = useDshStore(state => state.sessions)
  const connection = useDshStore(state => state.connection)
  const refreshWorkspaces = useDshStore(state => state.refreshWorkspaces)
  const [, setPoll] = useState(0)

  // Live transport stats refresh
  useEffect(() => {
    if (!rightPanelOpen && !inline) return
    const timer = window.setInterval(() => setPoll(n => n + 1), 2000)
    return () => window.clearInterval(timer)
  }, [rightPanelOpen, inline])

  const pickWorkspace = useCallback(async (path: string) => {
    const store = useDshStore.getState()
    const client = store.requireClient()
    const existing = store.workspaces.find(workspace => workspace.path === path)
    if (existing === undefined) {
      await client.workspaceCreate(path).catch(() => undefined)
    }
    await refreshWorkspaces()
    // 选择即切换：同步侧边栏当前目录，使左侧会话列表聚焦该工作区的会话。
    setCurrentDirectory(normalizeToForwardSlash(path))
  }, [refreshWorkspaces, setCurrentDirectory])

  if (!inline && !rightPanelOpen) return null

  const content = !renderPanelContent ? null : (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4 text-sm">
      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-400">{t('panel.host')}</h3>
        {hostDescriptor === undefined ? (
          <p className="text-text-300">{t('panel.notConnected')}</p>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-text-200">
            <dt className="text-text-400">{t('panel.version')}</dt>
            <dd>{hostDescriptor.version}</dd>
            <dt className="text-text-400">{t('panel.cwd')}</dt>
            <dd className="break-all">{hostDescriptor.cwd}</dd>
            <dt className="text-text-400">{t('panel.sessions')}</dt>
            <dd>{hostDescriptor.attachedSessions}</dd>
            <dt className="text-text-400">{t('panel.transport')}</dt>
            <dd>
              {connection.stats.mode}
              {connection.stats.rttMs !== undefined ? ` · ${connection.stats.rttMs}ms` : ''}
            </dd>
          </dl>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-400">{t('panel.workspaces')}</h3>
        <WorkspacePicker onPick={path => void pickWorkspace(path)} />
        <ul className="mt-2 flex flex-col gap-1 text-xs text-text-300">
          {workspaces.map(workspace => (
            <li key={workspace.workspaceId} className="flex items-center justify-between gap-2">
              <span className="truncate" title={workspace.path}>{workspace.title || workspace.path}</span>
              <span className="shrink-0 text-text-400">{workspace.sessionIds.length}</span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-400">{t('panel.recentSessions')}</h3>
        <ul className="flex flex-col gap-1 text-xs text-text-300">
          {[...sessions]
            .filter(session => !session.blank && session.origin !== 'subagent')
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, 10)
            .map(session => (
              <li key={session.sessionId} className="flex items-center justify-between gap-2">
                <span className="truncate">{session.title || session.sessionId.slice(0, 8)}</span>
                {session.running && <span className="shrink-0 text-green-400">●</span>}
              </li>
            ))}
        </ul>
      </section>
    </div>
  )

  if (inline) {
    return <div className="h-full w-full overflow-hidden bg-bg-100">{content}</div>
  }

  return (
    <ResizablePanel
      position="right"
      isOpen={rightPanelOpen}
      size={rightPanelWidth}
      onSizeChange={(width: number) => layoutStore.setRightPanelWidth(width)}
      onClose={() => layoutStore.closeRightPanel()}
    >
      {content}
    </ResizablePanel>
  )
}
