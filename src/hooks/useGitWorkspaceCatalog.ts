import { useCallback, useState } from 'react'

export interface GitWorkspaceMeta {
  isGit: boolean
  rootDirectory: string
  workspaces: string[]
}

export interface GitWorkspaceCatalog {
  byProject: Record<string, GitWorkspaceMeta>
  get(projectId: string): GitWorkspaceMeta | undefined
  has(projectId: string): boolean
}

// dsh 版：Host 不透出 git worktree 结构（v1）；空目录保持 UI 分支不变。
const EMPTY: GitWorkspaceCatalog = {
  byProject: {},
  get: () => undefined,
  has: () => false,
}

export function useGitWorkspaceCatalog(_directories?: string[], _serverId?: string): {
  catalog: GitWorkspaceCatalog
  isLoading: boolean
  refresh: () => void
} {
  const [catalog] = useState<GitWorkspaceCatalog>(EMPTY)
  const refresh = useCallback(() => {}, [])
  return { catalog, isLoading: false, refresh }
}

export function requestGitWorkspaceCatalogRefresh(): void {}
