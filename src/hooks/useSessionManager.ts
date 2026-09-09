// ============================================
// useSessionManager - Session 加载（dsh 版）
// ============================================
//
// 职责：
// 1. 路由 session 变化时经 dsh store 拉取 session.history 并折叠为 ChatItem
// 2. loadMoreHistory → session.history(beforeSeq) 向上翻页
// 3. undo/redo 在 DSH 协议中没有对应操作（v1 no-op）

import { useCallback, useEffect, useRef } from 'react'
import { useDshStore } from '../dsh/chat/sessionStore'
import { splitSessionKey } from '../utils/sessionKey'

interface UseSessionManagerOptions {
  sessionId: string | null
  directory?: string
  onLoadComplete?: () => void
  onError?: (error: Error) => void
  onSessionMissing?: (sessionId: string) => void
}

interface LoadSessionOptions {
  force?: boolean
}

export function useSessionManager({ sessionId, onSessionMissing }: UseSessionManagerOptions) {
  void onSessionMissing
  const loadingRef = useRef<string | null>(null)

  const loadSession = useCallback(async (targetSessionId: string, options?: LoadSessionOptions) => {
    void options
    const rawId = splitSessionKey(targetSessionId).sessionId
    if (rawId.length === 0) return
    if (loadingRef.current === rawId) return
    loadingRef.current = rawId
    try {
      // The store keeps its session rows; openSession only needs the id.
      await useDshStore.getState().openSession(rawId)
    } finally {
      loadingRef.current = null
    }
  }, [])

  // 翻页必须按「当前窗格的路由会话」取游标：store 里每个会话各有自己的
  // beforeSeq/hasMore，早先按 sessions 列表猜目标会话会在多窗格下加载错会话
  // （甚至整条会话都翻不动，只剩一个没有 user 锚点的过程壳）。
  const loadMoreHistory = useCallback(async () => {
    if (!sessionId) return
    const rawId = splitSessionKey(sessionId).sessionId
    if (rawId.length === 0) return
    await useDshStore.getState().loadOlderHistory(rawId)
  }, [sessionId])

  const handleUndo = useCallback(async (_userMessageId: string) => {}, [])
  const handleRedo = useCallback(async () => {}, [])
  const handleRedoAll = useCallback(async () => {}, [])
  const clearRevert = useCallback(() => {}, [])

  // 路由 session 变化时自动加载历史
  useEffect(() => {
    if (!sessionId) return
    void loadSession(sessionId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  return {
    loadSession,
    loadMoreHistory,
    handleUndo,
    handleRedo,
    handleRedoAll,
    clearRevert,
  }
}
