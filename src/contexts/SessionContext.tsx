import { useState, useCallback, useEffect, useMemo, type ReactNode } from 'react'
import { useDshStore } from '../dsh/chat/sessionStore'
import { remoteSessionToApiSession } from '../dsh/chat/uiAdapters'
import { SessionContext, type SessionContextValue } from './SessionContext.shared'

// dsh-backed session context: the connected Host is the single source of truth
// for the session list (see useSessions for the standalone variant).

export function SessionProvider({ children }: { children: ReactNode }) {
  const connected = useDshStore(state => state.connection.phase === 'connected')
  const hostCwd = useDshStore(state => state.hostDescriptor?.cwd)
  const storeSessions = useDshStore(state => state.sessions)
  const [search, setSearch] = useState('')

  const sessions = useMemo(
    () => storeSessions
      .filter(session => session.origin !== 'subagent' && !session.blank)
      .map(session => remoteSessionToApiSession(session, hostCwd))
      .filter(session => !search || session.title.toLowerCase().includes(search.toLowerCase())),
    [storeSessions, hostCwd, search],
  )

  const refresh = useCallback(async () => {
    await useDshStore.getState().refreshWorkspaces()
  }, [])

  const loadMore = useCallback(async () => {}, [])

  const createSession = useCallback(async (_title?: string) => {
    const state = useDshStore.getState()
    await state.createSession(state.workspaces[0]?.workspaceId)
    const created = useDshStore.getState().sessions.find(session => !session.blank)
      ?? useDshStore.getState().sessions[0]
    return remoteSessionToApiSession(created ?? { sessionId: '', updatedAt: 0, running: false, blank: true }, hostCwd)
  }, [hostCwd])

  const deleteSession = useCallback(async (id: string) => {
    await useDshStore.getState().archiveSession(id)
  }, [])

  useEffect(() => {
    if (connected) void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected])

  const value = useMemo<SessionContextValue>(
    () => ({
      sessions,
      isLoading: connected && storeSessions.length === 0,
      isLoadingMore: false,
      hasMore: false,
      search,
      setSearch,
      refresh,
      loadMore,
      createSession,
      deleteSession,
    }),
    [sessions, connected, search, refresh, loadMore, createSession, deleteSession],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}
