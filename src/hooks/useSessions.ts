// useSessions — dsh-backed session list (replaces the OpenCode REST paging).
// Sessions come from the connected Host via `session.list`; live updates ride
// the mux stream into the dsh session store.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiSession } from '../api'
import { useDshStore } from '../dsh/chat/sessionStore'
import { remoteSessionToApiSession } from '../dsh/chat/uiAdapters'
import { pinnedSessionsStore } from '../store/pinnedSessionsStore'

interface UseSessionsOptions {
  pageSize?: number
  initialSearch?: string
  rootsOnly?: boolean
  directory?: string
  enabled?: boolean
  serverId?: string
}

interface UseSessionsResult {
  sessions: ApiSession[]
  isLoading: boolean
  isLoadingMore: boolean
  error: Error | null
  hasMore: boolean
  search: string
  setSearch: (search: string) => void
  loadMore: () => Promise<void>
  refresh: () => Promise<void>
  create: (title?: string) => Promise<ApiSession>
  remove: (sessionId: string) => Promise<void>
  patchLocalSession: (sessionId: string, patch: Partial<ApiSession>) => void
  removeLocalSession: (sessionId: string) => void
}

export function useSessions(options: UseSessionsOptions = {}): UseSessionsResult {
  const { initialSearch = '', directory, enabled = true } = options

  const normalizedDirectory = directory ? directory.replace(/\\/g, '/').replace(/\/$/, '') : undefined
  const connected = useDshStore(state => state.connection.phase === 'connected')
  const hostCwd = useDshStore(state => state.hostDescriptor?.cwd)
  const storeSessions = useDshStore(state => state.sessions)

  const [search, setSearch] = useState(initialSearch)
  const searchRef = useRef(search)
  useEffect(() => {
    searchRef.current = search
  }, [search])

  const sessions = useMemo(
    () => storeSessions
      .filter(session => session.origin !== 'subagent' && !session.blank)
      .map(session => remoteSessionToApiSession(session, hostCwd))
      .filter(session => !normalizedDirectory || session.directory.replace(/\\/g, '/').replace(/\/$/, '') === normalizedDirectory)
      .filter(session => !searchRef.current
        || session.title.toLowerCase().includes(searchRef.current.toLowerCase())),
    [storeSessions, hostCwd, normalizedDirectory],
  )

  const refresh = useCallback(async () => {
    await useDshStore.getState().refreshWorkspaces()
  }, [])

  const create = useCallback(async (_title?: string) => {
    const state = useDshStore.getState()
    const workspaceId = state.workspaces.find(workspace => workspace.path === normalizedDirectory)?.workspaceId
    await state.createSession(workspaceId)
    const created = useDshStore.getState().sessions.find(session => !session.blank)
      ?? useDshStore.getState().sessions[0]
    return remoteSessionToApiSession(created ?? { sessionId: '', updatedAt: 0, running: false, blank: true }, hostCwd)
  }, [normalizedDirectory, hostCwd])

  const remove = useCallback(async (sessionId: string) => {
    pinnedSessionsStore.unpin(sessionId)
    await useDshStore.getState().archiveSession(sessionId)
  }, [])

  const loadMore = useCallback(async () => {
    // All sessions arrive in one page from the Host; nothing to page.
  }, [])

  const patchLocalSession = useCallback((_sessionId: string, _patch: Partial<ApiSession>) => {
    // dsh sessions are authoritative from the Host; local patches are not needed
  }, [])

  const removeLocalSession = useCallback((_sessionId: string) => {
    // handled by the dsh store
  }, [])

  return {
    sessions: enabled && connected ? sessions : [],
    isLoading: enabled && connected ? storeSessions.length === 0 : false,
    isLoadingMore: false,
    error: null,
    hasMore: false,
    search,
    setSearch,
    loadMore,
    refresh,
    create,
    remove,
    patchLocalSession,
    removeLocalSession,
  }
}
