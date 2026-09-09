import { useSyncExternalStore } from 'react'
import type { ApiProject } from '../api'
import { useDshStore } from '../dsh/chat/sessionStore'

export interface UseProjectResult {
  currentProject: ApiProject | null
  projects: ApiProject[]
  isLoading: boolean
  refreshProjects: () => Promise<void>
  switchProject: (projectId: string) => Promise<void>
}

// dsh 版：单一 Host 工作区即“项目”
export function useProject(): UseProjectResult {
  const state = useSyncExternalStore(
    cb => useDshStore.subscribe(cb),
    () => ({
      cwd: useDshStore.getState().hostDescriptor?.cwd ?? '',
      connected: useDshStore.getState().connection.phase === 'connected',
      workspaces: useDshStore.getState().workspaces,
    }),
    () => ({
      cwd: '',
      connected: false,
      workspaces: [] as import('../dsh/types').WorkspaceView[],
    }),
  )

  const currentProject: ApiProject | null = state.connected
    ? {
        id: 'dsh',
        worktree: state.cwd,
        time: { created: 0 },
      } as unknown as ApiProject
    : null

  return {
    currentProject,
    projects: currentProject !== null ? [currentProject] : [],
    isLoading: false,
    refreshProjects: async () => {},
    switchProject: async () => {},
  }
}
