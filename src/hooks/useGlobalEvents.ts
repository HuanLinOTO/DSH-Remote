// ============================================
// useGlobalEvents - DSH mux 事件分发（替代原 OpenCode SSE 订阅）
// ============================================
//
// 职责：
// 1. 订阅 dsh session store（mux 帧经 event-reducer 折叠为 chatItems）
// 2. 将 approval/question 变化按 sessionId 分发给 pane 消费者
// 3. 连接状态变化 → 广播 reconnect / 清理
//
// 消息流本身经 dsh/chat/bridge 直达 messageStore，不经过本文件。

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { messageStore } from '../store'
import { activeSessionStore } from '../store/activeSessionStore'
import { notificationStore } from '../store/notificationStore'
import { clearSessionRuntimeState } from '../utils/sessionLifecycle'
import { useDshStore } from '../dsh/chat/sessionStore'
import { pendingApprovals, pendingQuestions, approvalToPermissionRequest, questionToApiRequest } from '../dsh/chat/uiAdapters'
import { startDshChatBridge } from '../dsh/chat/bridge'
import type { ChatItem } from '../dsh/types'
import type { ApiPermissionRequest, ApiQuestionRequest } from '../api/types'

// ============================================
// Session-level pub/sub 消费者注册（保持原接口形态）
// ============================================

export interface SessionEventCallbacks {
  onPermissionAsked?: (request: ApiPermissionRequest) => void
  onPermissionReplied?: (data: { sessionID: string; requestID: string }) => void
  onQuestionAsked?: (request: ApiQuestionRequest) => void
  onQuestionReplied?: (data: { sessionID: string; requestID: string }) => void
  onQuestionRejected?: (data: { sessionID: string; requestID: string }) => void
  onScrollRequest?: () => void
  onSessionIdle?: (sessionID: string) => void
  onSessionError?: (sessionID: string) => void
  onReconnected?: (reason: 'network' | 'server-switch') => void
}

interface SessionConsumer {
  sessionId: string | null
  callbacks: SessionEventCallbacks
}

const sessionConsumers = new Map<string, SessionConsumer>()

export function registerSessionConsumer(
  consumerId: string,
  sessionId: string | null,
  callbacks: SessionEventCallbacks,
): () => void {
  sessionConsumers.set(consumerId, { sessionId, callbacks })
  return () => {
    sessionConsumers.delete(consumerId)
  }
}

export function updateConsumerSessionId(consumerId: string, sessionId: string | null) {
  const c = sessionConsumers.get(consumerId)
  if (c) c.sessionId = sessionId
}

function hasConsumerForSession(sessionId: string): boolean {
  for (const consumer of sessionConsumers.values()) {
    if (consumer.sessionId === sessionId) return true
  }
  return false
}

export function hasOtherConsumerForSession(sessionId: string, consumerId: string): boolean {
  for (const [id, consumer] of sessionConsumers.entries()) {
    if (id === consumerId) continue
    if (consumer.sessionId === sessionId) return true
  }
  return false
}

function dispatchToConsumers(sessionId: string, invoke: (cb: SessionEventCallbacks) => void): boolean {
  let dispatched = false
  for (const consumer of sessionConsumers.values()) {
    if (!consumer.sessionId) continue
    if (consumer.sessionId === sessionId) {
      invoke(consumer.callbacks)
      dispatched = true
    }
  }
  return dispatched
}

/** Extract the raw dsh sessionId from a consumer-facing (composite) id. */
function rawSessionId(sessionKey: string): string {
  const idx = sessionKey.indexOf('::')
  return idx === -1 ? sessionKey : sessionKey.slice(idx + 2)
}

// ============================================
// Diff helpers: track pending approvals/questions per session across renders
// ============================================

interface PendingSnapshot {
  approvals: Map<string, ApiPermissionRequest>
  questions: Map<string, ApiQuestionRequest>
}

function snapshotPending(chatItems: Record<string, ChatItem[]>): PendingSnapshot {
  const approvals = new Map<string, ApiPermissionRequest>()
  const questions = new Map<string, ApiQuestionRequest>()
  for (const [sessionId, items] of Object.entries(chatItems)) {
    for (const approval of pendingApprovals(items)) {
      const request = approvalToPermissionRequest(approval)
      approvals.set(request.id, { ...request, sessionID: sessionId })
    }
    for (const question of pendingQuestions(items)) {
      const request = questionToApiRequest(question)
      questions.set(request.id, { ...request, sessionID: sessionId })
    }
  }
  return { approvals, questions }
}

export function useGlobalEvents(_directories?: string[]) {
  const refreshRef = useRef<(() => void) | null>(null)
  const initializedRef = useRef(false)
  const lastSnapshotRef = useRef<PendingSnapshot>({ approvals: new Map(), questions: new Map() })
  const lastPhaseRef = useRef<string>('disconnected')
  const [connected, setConnected] = useState(false)

  const phase = useDshStore(state => state.connection.phase)
  const chatItems = useDshStore(state => state.chatItems)
  const sessions = useDshStore(state => state.sessions)

  // messageStore feed (chatItems → Message[])
  useEffect(() => {
    startDshChatBridge()
  }, [])

  // Connection phase transitions → consumers + Working list + stale marks
  useEffect(() => {
    if (lastPhaseRef.current === phase) return
    const previous = lastPhaseRef.current
    lastPhaseRef.current = phase
    setConnected(phase === 'connected')

    if (phase === 'connected' && previous !== 'disconnected') {
      // (re)connection completed: refresh consumers' data
      for (const consumer of sessionConsumers.values()) {
        consumer.callbacks.onReconnected?.('network')
      }
    }
    if (phase === 'disconnected' || phase === 'offline') {
      messageStore.markAllSessionsStale()
    }
  }, [phase])

  // Working 列表（activeSessionStore）与 Host 会话 running 状态对齐
  useEffect(() => {
    const statusMap = activeSessionStore.getSnapshot().statusMap
    for (const session of sessions) {
      const key = session.sessionId
      const isBusy = session.running
      const wasBusy = statusMap[key] !== undefined && (statusMap[key].type === 'busy' || statusMap[key].type === 'retry')
      if (isBusy && !wasBusy) {
        activeSessionStore.updateStatus(key, { type: 'busy' })
      } else if (!isBusy && wasBusy) {
        activeSessionStore.updateStatus(key, { type: 'idle' })
        const meta = activeSessionStore.getSessionMeta(key)
        notificationStore.push('completed', meta?.title || key.slice(0, 8), 'Session completed', key, meta?.directory)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions])

  // Approval/question 生命周期 → 消费者回调
  useEffect(() => {
    const next = snapshotPending(chatItems)

    for (const [id, request] of next.approvals) {
      if (!lastSnapshotRef.current.approvals.has(id)) {
        activeSessionStore.addPendingRequest(id, request.sessionID, 'permission')
        dispatchToConsumers(request.sessionID, cb => cb.onPermissionAsked?.(request))
      }
    }
    for (const id of lastSnapshotRef.current.approvals.keys()) {
      if (!next.approvals.has(id)) {
        const previous = lastSnapshotRef.current.approvals.get(id)
        activeSessionStore.resolvePendingRequest(id)
        if (previous !== undefined) {
          dispatchToConsumers(previous.sessionID, cb => cb.onPermissionReplied?.({ sessionID: previous.sessionID, requestID: id }))
        }
      }
    }

    for (const [id, request] of next.questions) {
      if (!lastSnapshotRef.current.questions.has(id)) {
        activeSessionStore.addPendingRequest(id, request.sessionID, 'question')
        dispatchToConsumers(request.sessionID, cb => cb.onQuestionAsked?.(request))
      }
    }
    for (const id of lastSnapshotRef.current.questions.keys()) {
      if (!next.questions.has(id)) {
        const previous = lastSnapshotRef.current.questions.get(id)
        activeSessionStore.resolvePendingRequest(id)
        if (previous !== undefined) {
          dispatchToConsumers(previous.sessionID, cb => {
            cb.onQuestionReplied?.({ sessionID: previous.sessionID, requestID: id })
            cb.onQuestionRejected?.({ sessionID: previous.sessionID, requestID: id })
          })
        }
      }
    }

    lastSnapshotRef.current = next
  }, [chatItems])

  const refresh = useCallback(() => {
    void useDshStore.getState().refreshWorkspaces()
  }, [])

  refreshRef.current = refresh

  useLayoutEffect(() => {
    if (initializedRef.current) {
      refreshRef.current?.()
      return
    }
    initializedRef.current = true
  }, [])

  // session 删除清理（dsh 无 session.deleted 帧的 v1：会话列表以 Host 为准）
  useEffect(() => {
    return () => {
      for (const consumer of sessionConsumers.values()) {
        if (consumer.sessionId !== null) clearSessionRuntimeState(rawSessionId(consumer.sessionId))
      }
    }
  }, [])

  return { connected }
}

// kept for parity with the previous export surface
export { hasConsumerForSession }
