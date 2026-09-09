// usePermissionHandler — dsh-backed approval/question replies.
// request.id is the dsh ChatItem id (`approval:<id>` / `question:<rpcId>`);
// replies go through the dsh session store (respondApproval/respondQuestion).

import { useCallback, useRef, useState, useEffect } from 'react'
import type {
  ApiPermissionRequest,
  ApiQuestionRequest,
  PermissionReply,
  QuestionAnswer,
} from '../api'
import { activeSessionStore } from '../store'
import { useDshStore } from '../dsh/chat/sessionStore'
import {
  pendingApprovals,
  pendingQuestions,
  questionToApiRequest,
  approvalToPermissionRequest,
} from '../dsh/chat/uiAdapters'
import type { ChatItem, QuestionActivity } from '../dsh/types'

export interface UsePermissionHandlerResult {
  pendingPermissionRequests: ApiPermissionRequest[]
  pendingQuestionRequests: ApiQuestionRequest[]
  setPendingPermissionRequests: React.Dispatch<React.SetStateAction<ApiPermissionRequest[]>>
  setPendingQuestionRequests: React.Dispatch<React.SetStateAction<ApiQuestionRequest[]>>
  handlePermissionReply: (
    requestId: string,
    reply: PermissionReply,
    directory?: string,
    sessionId?: string,
  ) => Promise<boolean>
  handleQuestionReply: (requestId: string, answers: QuestionAnswer[], directory?: string) => Promise<boolean>
  handleQuestionReject: (requestId: string, directory?: string) => Promise<boolean>
  refreshPendingRequests: (sessionIds?: string | string[], directory?: string) => Promise<void>
  resetPendingRequests: () => void
  isReplying: boolean
}

export function usePermissionHandler(serverId: string): UsePermissionHandlerResult {
  void serverId
  const [isReplying, setIsReplying] = useState(false)
  const replyingIdsRef = useRef<Set<string>>(new Set())

  const chatItems = useDshStore(state => state.chatItems)

  // Pending approvals/questions derive directly from the mux stream state.
  const pendingPermissionRequests = (
    Object.values(chatItems).flatMap(items => pendingApprovals(items).map(approvalToPermissionRequest))
  )
  const pendingQuestionRequests = (
    Object.values(chatItems).flatMap(items => pendingQuestions(items).map(questionToApiRequest))
  )

  const handlePermissionReply = useCallback(
    async (requestId: string, reply: PermissionReply, _directory?: string, _sessionId?: string): Promise<boolean> => {
      if (replyingIdsRef.current.has(requestId)) return false
      replyingIdsRef.current.add(requestId)
      setIsReplying(true)
      try {
        const outcome = reply === 'reject' ? 'rejected' as const : 'allowed-once' as const
        await useDshStore.getState().respondApproval(requestId, outcome)
        return true
      } catch {
        return false
      } finally {
        replyingIdsRef.current.delete(requestId)
        setIsReplying(false)
      }
    },
    [],
  )

  const handleQuestionReply = useCallback(
    async (requestId: string, answers: QuestionAnswer[], _directory?: string): Promise<boolean> => {
      if (replyingIdsRef.current.has(requestId)) return false
      replyingIdsRef.current.add(requestId)
      setIsReplying(true)
      try {
        const state = useDshStore.getState()
        const item = findQuestionItem(state.chatItems, requestId)
        if (item === undefined) return false
        const selected: Record<string, string[]> = {}
        item.questions.forEach((question, index) => {
          selected[question.id] = answers[index] ?? []
        })
        await state.respondQuestion(requestId, selected)
        return true
      } catch {
        return false
      } finally {
        replyingIdsRef.current.delete(requestId)
        setIsReplying(false)
      }
    },
    [],
  )

  const handleQuestionReject = useCallback(
    async (_requestId: string, _directory?: string): Promise<boolean> => {
      // DSH has no client-side "reject" for questions; cancellation is
      // initiated by the Host when the turn is cancelled.
      return true
    },
    [],
  )

  const refreshPendingRequests = useCallback(async (_sessionIds?: string | string[], _directory?: string) => {
    // Derived from mux state; nothing to fetch.
  }, [])

  const resetPendingRequests = useCallback(() => {
    replyingIdsRef.current.clear()
  }, [])

  // Active-tab badges stay in sync with the derived pending lists.
  useEffect(() => {
    for (const request of pendingPermissionRequests) {
      activeSessionStore.addPendingRequest(request.id, request.sessionID, 'permission')
    }
    for (const request of pendingQuestionRequests) {
      activeSessionStore.addPendingRequest(request.id, request.sessionID, 'question')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPermissionRequests.length, pendingQuestionRequests.length])

  return {
    pendingPermissionRequests,
    pendingQuestionRequests,
    setPendingPermissionRequests: () => {},
    setPendingQuestionRequests: () => {},
    handlePermissionReply,
    handleQuestionReply,
    handleQuestionReject,
    refreshPendingRequests,
    resetPendingRequests,
    isReplying,
  }
}

function findQuestionItem(chatItems: Record<string, ChatItem[]>, requestId: string): QuestionActivity | undefined {
  for (const items of Object.values(chatItems)) {
    const found = items.find(item => item.kind === 'question' && (item.frameRpcId === requestId || item.id === requestId))
    if (found !== undefined && found.kind === 'question') return found
  }
  return undefined
}
