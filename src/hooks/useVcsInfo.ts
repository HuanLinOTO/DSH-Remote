import { useEffect, useState } from 'react'

type VcsInfo = { branch: string }

// dsh 版：隧道不透出 VCS 信息（v1）；返回空结果保持 UI 分支不变。
export interface UseVcsInfoResult {
  vcsInfo: VcsInfo | null
  isLoading: boolean
}

export function useVcsInfo(_directory?: string, _serverId?: string): UseVcsInfoResult {
  const [vcsInfo] = useState<VcsInfo | null>(null)
  useEffect(() => {}, [])
  return { vcsInfo, isLoading: false }
}
