// ============================================
// useChatSession - 聊天会话管理（dsh 版）
// ============================================
//
// 数据源：messageStore（经 dsh/chat/bridge 从 ChatItem 折叠而来）
// 动作：发送/停止经 dsh sessionStore（rc.2 ApiProxy 或 alpha Gateway）
// 与 OpenCode 相关的 undo/redo/fork/agents/commands 在 DSH 协议中没有
// 对应操作，保留返回形状但为 no-op（对应 UI 入口在拆除阶段隐藏）。

import { useState, useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { useActiveSessionStore } from '../store/activeSessionStore'
import { usePermissionHandler } from './usePermissionHandler'
import {
  messageStore,
  useSessionState,
  type RevertHistoryItem,
} from '../store'
import {
  useSessionManager,
  registerSessionConsumer,
  updateConsumerSessionId,
  hasOtherConsumerForSession,
} from '../hooks'
import { usePermissions, useMessageAnimation, useDirectory, useSessionContext } from '../hooks'
import type { Attachment, ModelInfo, ApiAgent } from '../api'
import type { Message as UIMessage } from '../types/message'
import { clipboardErrorHandler, copyTextToClipboard, isSameDirectory } from '../utils'
import type { ChatAreaHandle } from '../features/chat'
import { followupQueueStore, useFollowupQueue } from '../store/followupQueueStore'
import { themeStore } from '../store/themeStore'
import { splitSessionKey, makeSessionKey } from '../utils/sessionKey'
import { useDshStore } from '../dsh/chat/sessionStore'
import { fileToPromptImage, totalImageBytes, IMAGE_ATTACHMENT_LIMITS } from '../dsh/chat/image-attachments'
import { remoteSessionToApiSession } from '../dsh/chat/uiAdapters'
import type { PromptImage } from '../dsh/types'

/**
 * Stable empty session state singleton (see original implementation notes).
 */
const EMPTY_SESSION_STATE = {
  messages: [] as import('../types/message').Message[],
  isStreaming: false,
  loadState: 'idle' as const,
  loadError: undefined,
  revertState: null,
  canUndo: false,
  canRedo: false,
  redoSteps: 0,
  revertedContent: null,
  hasMoreHistory: false,
  directory: '',
  title: null,
} as const

interface UseChatSessionOptions {
  paneId: string
  chatAreaRef: React.RefObject<ChatAreaHandle | null>
  currentModel: ModelInfo | undefined
  refetchModels: () => Promise<void>
  sessionId: string | null
  navigateToSession: (sessionId: string, directory?: string) => void
  navigateHome: () => void
}

interface LiveRetryStatus {
  sessionID: string
  attempt: number
  message: string
  next: number
}

export function useChatSession({
  paneId,
  chatAreaRef,
  sessionId: routeSessionId,
  navigateToSession,
  navigateHome,
  refetchModels,
}: UseChatSessionOptions) {
  const { statusMap } = useActiveSessionStore()
  const { queueFollowupMessages } = useSyncExternalStore(themeStore.subscribe, themeStore.getSnapshot)

  const [restoredContent, setRestoredContent] = useState<{ sessionId: string; content: RevertHistoryItem } | null>(null)

  const { resetPermissions } = usePermissions()
  const { currentDirectory } = useDirectory()
  const { sessions } = useSessionContext()

  const routeStatus = routeSessionId ? statusMap[routeSessionId] : undefined
  const routeSessionIdRef = useRef(routeSessionId)

  useEffect(() => {
    routeSessionIdRef.current = routeSessionId
  }, [routeSessionId])


  const handleMissingRouteSession = useCallback(
    (missingSessionId: string) => {
      if (routeSessionIdRef.current !== missingSessionId) return
      navigateHome()
    },
    [navigateHome],
  )

  const {
    items: queuedFollowups,
    sendingId: queuedFollowupSendingId,
    failedId: queuedFollowupFailedId,
  } = useFollowupQueue(routeSessionId)

  const perSessionStateRaw = useSessionState(routeSessionId)
  const perSessionState = perSessionStateRaw ?? EMPTY_SESSION_STATE

  const messages = perSessionState.messages
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const isStreaming = perSessionState.isStreaming
  const sessionDirectory = perSessionState.directory || currentDirectory || ''
  const hasMoreHistory = perSessionState.hasMoreHistory
  const loadState = routeSessionId ? perSessionState.loadState : ('idle' as const)
  const loadError = routeSessionId ? perSessionState.loadError : undefined

  const retryStatus = useMemo<LiveRetryStatus | null>(() => {
    if (!routeSessionId || routeStatus?.type !== 'retry') return null
    return {
      sessionID: routeSessionId,
      attempt: routeStatus.attempt,
      message: routeStatus.message,
      next: routeStatus.next,
    }
  }, [routeSessionId, routeStatus])

  const isSessionBusy = useMemo(() => Boolean(routeStatus) || isStreaming, [routeStatus, isStreaming])

  // Session Manager（dsh 版：历史还原 + 翻页）
  const { loadSession, loadMoreHistory, handleRedoAll, clearRevert } = useSessionManager({
    sessionId: routeSessionId,
    directory: currentDirectory,
    onSessionMissing: handleMissingRouteSession,
  })

  // Permission handling（dsh 版：审批/提问经 mux 帧）
  const {
    pendingPermissionRequests,
    pendingQuestionRequests,
    handlePermissionReply,
    handleQuestionReply,
    handleQuestionReject,
    refreshPendingRequests,
    resetPendingRequests,
    isReplying,
  } = usePermissionHandler('')

  // Message animations
  const { registerMessage, registerInputBox } = useMessageAnimation()

  const effectiveDirectory = sessionDirectory

  // ============================================
  // dsh 事件回调（approval / question / reconnect）按 pane 消费
  // ============================================
  const callbacks = useMemo(
    () => ({
      onPermissionAsked: () => {
        // 派生状态在 usePermissionHandler 中已包含；这里仅保留滚动/通知钩位
      },
      onPermissionReplied: () => {},
      onQuestionAsked: () => {},
      onQuestionReplied: () => {},
      onQuestionRejected: () => {},
      onScrollRequest: () => {
        chatAreaRef.current?.scrollToBottomIfAtBottom()
      },
      onSessionIdle: (_sessionID: string) => {},
      onSessionError: (_sessionID: string) => {},
      onReconnected: (_reason: 'network' | 'server-switch') => {
        messageStore.markAllSessionsStale()
        if (routeSessionId) {
          loadSession(routeSessionId, { force: true })
          refreshPendingRequests(routeSessionId, effectiveDirectory)
        }
        refetchModels().catch(() => {})
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs and stable functions
    [paneId, effectiveDirectory, routeSessionId, loadSession, refreshPendingRequests, refetchModels, chatAreaRef],
  )

  const callbacksRef = useRef(callbacks)
  useEffect(() => {
    callbacksRef.current = callbacks
  }, [callbacks])

  useEffect(() => {
    const unregister = registerSessionConsumer(paneId, routeSessionId, {
      onPermissionAsked: () => callbacksRef.current.onPermissionAsked(),
      onPermissionReplied: () => callbacksRef.current.onPermissionReplied(),
      onQuestionAsked: () => callbacksRef.current.onQuestionAsked(),
      onQuestionReplied: () => callbacksRef.current.onQuestionReplied(),
      onQuestionRejected: () => callbacksRef.current.onQuestionRejected(),
      onScrollRequest: () => callbacksRef.current.onScrollRequest(),
      onSessionIdle: sid => callbacksRef.current.onSessionIdle(sid),
      onSessionError: sid => callbacksRef.current.onSessionError(sid),
      onReconnected: reason => callbacksRef.current.onReconnected(reason),
    })
    return unregister
  }, [paneId, routeSessionId])

  useEffect(() => {
    updateConsumerSessionId(paneId, routeSessionId)
  }, [paneId, routeSessionId])

  // Pending approvals/questions derive from the dsh store; refresh on session change.
  useEffect(() => {
    resetPendingRequests()
  }, [routeSessionId, resetPendingRequests])

  // 附件(原 OpenCodeUI 的 Attachment 形状) → dsh PromptImage[]
  const attachmentsToPromptImages = useCallback(async (attachments: Attachment[]): Promise<PromptImage[]> => {
    const files = attachments.filter(
      attachment => attachment.type === 'file' && attachment.mime?.startsWith('image/') === true,
    )
    if (files.length === 0) return []
    if (files.length > IMAGE_ATTACHMENT_LIMITS.maxImagesPerMessage) {
      throw new Error(`At most ${IMAGE_ATTACHMENT_LIMITS.maxImagesPerMessage} images per message.`)
    }
    const images: PromptImage[] = []
    for (const attachment of files) {
      if (attachment.url === undefined || attachment.url.length === 0) continue
      const response = await fetch(attachment.url)
      const blob = await response.blob()
      const file = new File([blob], attachment.displayName || 'image', { type: attachment.mime })
      images.push(await fileToPromptImage(file))
    }
    if (totalImageBytes(images) > IMAGE_ATTACHMENT_LIMITS.maxMessageImageBytes) {
      throw new Error('The total image size exceeds the message limit.')
    }
    return images
  }, [])

  const sendMessageNow = useCallback(
    async (input: {
      sessionId?: string | null
      content: string
      attachments: Attachment[]
      allowCreateSession?: boolean
    }) => {
      let sessionId = input.sessionId ?? routeSessionId

      if (!sessionId && input.allowCreateSession) {
        const store = useDshStore.getState()
        const client = store.requireClient()
        // 首条消息惰性建会话：落在当前目录对应的工作区（侧边栏已按 Host
        // 工作区分组，"+" 新建不应总是落到第一个工作区）；无目录/无匹配时
        // 保持旧行为（第一个工作区）。
        const directory = effectiveDirectory
        const workspaceId = (directory
          ? store.workspaces.find(workspace => isSameDirectory(workspace.path, directory))?.workspaceId
          : undefined) ?? store.workspaces[0]?.workspaceId
        const { sessionId: newId } = await client.sessionCreate(workspaceId)
        await store.refreshWorkspaces()
        const hostDeviceId = store.selectedDevice?.deviceId
        const scopedId = hostDeviceId !== undefined ? makeSessionKey(hostDeviceId, newId) : newId
        navigateToSession(scopedId)
        sessionId = scopedId
      }

      if (!sessionId) return false

      const rawSessionId = splitSessionKey(sessionId).sessionId
      try {
        const images = await attachmentsToPromptImages(input.attachments)
        const ok = await useDshStore.getState().sendMessage(rawSessionId, input.content, images)
        if (!ok) return false
        messageStore.setStreaming(sessionId, true)
        return true
      } catch (error) {
        messageStore.setStreaming(sessionId, false)
        if (error instanceof Error) console.warn('[dsh] send failed:', error.message)
        return false
      }
    },
    [routeSessionId, navigateToSession, attachmentsToPromptImages, effectiveDirectory],
  )

  // Send message handler
  const handleSend = useCallback(
    async (content: string, attachments: Attachment[], _options?: { agent?: string; variant?: string }) => {
      if (routeSessionId && queuedFollowupFailedId) {
        followupQueueStore.remove(routeSessionId, queuedFollowupFailedId)
      }

      const shouldQueueFollowup =
        !!routeSessionId && (queuedFollowups.length > 0 || (queueFollowupMessages && isSessionBusy))

      if (shouldQueueFollowup) {
        followupQueueStore.enqueue({
          sessionId: routeSessionId,
          directory: effectiveDirectory || '',
          text: content,
          attachments,
          model: { providerID: '', modelID: '' },
        })
        return true
      }

      try {
        return await sendMessageNow({
          sessionId: routeSessionId,
          content,
          attachments,
          allowCreateSession: true,
        })
      } catch {
        return false
      }
    },
    [routeSessionId, queuedFollowups.length, queuedFollowupFailedId, queueFollowupMessages, isSessionBusy, effectiveDirectory, sendMessageNow],
  )

  const sendQueuedFollowup = useCallback(
    async (draftId: string, sessionId: string) => {
      const draft = followupQueueStore.getItem(sessionId, draftId)
      if (!draft) return false
      if (!followupQueueStore.startSending(draft.sessionId, draft.id)) return false

      messageStore.removeMessage(draft.sessionId, draft.id)

      const ok = await sendMessageNow({
        sessionId: draft.sessionId,
        content: draft.text,
        attachments: draft.attachments,
        allowCreateSession: false,
      }).catch(() => false)

      followupQueueStore.finishSending(draft.sessionId, draft.id)

      if (ok) {
        followupQueueStore.remove(draft.sessionId, draft.id)
      } else {
        followupQueueStore.markFailed(draft.sessionId, draft.id)
        const remaining = followupQueueStore.getItems(draft.sessionId)
        for (const item of remaining) {
          messageStore.removeMessage(draft.sessionId, item.id)
        }
        setRestoredContent({
          sessionId: draft.sessionId,
          content: {
            messageId: draft.id,
            text: draft.text,
            attachments: draft.attachments,
            model: draft.model,
            variant: draft.variant ?? draft.model.variant,
            agent: draft.agent,
          },
        })
      }

      return ok
    },
    [sendMessageNow],
  )

  useEffect(() => {
    if (!routeSessionId) return

    const nextQueued = queuedFollowups[0]
    if (!nextQueued) return
    if (queuedFollowupSendingId) return
    if (queuedFollowupFailedId) return
    if (isSessionBusy) return

    void sendQueuedFollowup(nextQueued.id, routeSessionId)
  }, [
    routeSessionId,
    queuedFollowups,
    queuedFollowupSendingId,
    queuedFollowupFailedId,
    isSessionBusy,
    sendQueuedFollowup,
  ])

  // New chat handler
  const handleNewChat = useCallback(() => {
    if (routeSessionId && !hasOtherConsumerForSession(routeSessionId, paneId)) {
      messageStore.clearSession(routeSessionId)
    }
    resetPermissions()
    resetPendingRequests()
  }, [routeSessionId, paneId, resetPermissions, resetPendingRequests])

  // Abort handler
  const handleAbort = useCallback(async () => {
    if (!routeSessionId) return
    try {
      await useDshStore.getState().stopSession(splitSessionKey(routeSessionId).sessionId)
      messageStore.handleSessionIdle(routeSessionId)
    } catch {
      // error surfaced via the dsh store
    }
  }, [routeSessionId])

  // Command handler (slash commands) — only /new remains meaningful
  const handleCommand = useCallback(
    async (commandStr: string) => {
      const trimmed = commandStr.trim()
      const withoutSlash = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed
      const command = withoutSlash.split(' ')[0] ?? ''
      if (command === 'new') {
        navigateHome()
        handleNewChat()
        return true
      }
      return false
    },
    [navigateHome, handleNewChat],
  )

  // Undo/Redo are not part of the DSH protocol (no-op stubs, kept for shape)
  const handleUndoWithAnimation = useCallback(async (_userMessageId: string) => {}, [])
  const handleRedoWithAnimation = useCallback(async () => {}, [])

  // Session selection
  const handleSelectSession = useCallback(
    (session: { id: string; serverId?: string; directory?: string }) => {
      navigateToSession(session.id, session.directory)
    },
    [navigateToSession],
  )

  const handleNewSession = useCallback(() => {
    navigateHome()
    handleNewChat()
  }, [navigateHome, handleNewChat])

  const handleForkMessage = useCallback(async (_message: UIMessage, _forkMessageId?: string) => {}, [])

  // Archive current session (dsh: workspace.archiveSession)
  const handleArchiveSession = useCallback(async () => {
    if (!routeSessionId) return
    try {
      await useDshStore.getState().archiveSession(splitSessionKey(routeSessionId).sessionId)
      navigateHome()
      handleNewChat()
    } catch {
      // error surfaced via the dsh store
    }
  }, [routeSessionId, navigateHome, handleNewChat])

  const handlePreviousSession = useCallback(() => {
    if (!sessions.length) return
    const currentIndex = sessions.findIndex(s => s.id === routeSessionId)
    if (currentIndex > 0) {
      const target = sessions[currentIndex - 1]
      navigateToSession(target.id, target.directory)
    } else if (currentIndex === -1 && sessions.length > 0) {
      navigateToSession(sessions[0].id, sessions[0].directory)
    }
  }, [sessions, routeSessionId, navigateToSession])

  const handleNextSession = useCallback(() => {
    if (!sessions.length) return
    const currentIndex = sessions.findIndex(s => s.id === routeSessionId)
    if (currentIndex >= 0 && currentIndex < sessions.length - 1) {
      const target = sessions[currentIndex + 1]
      navigateToSession(target.id, target.directory)
    }
  }, [sessions, routeSessionId, navigateToSession])

  const handleCopyLastResponse = useCallback(async () => {
    const lastAssistant = [...messages].reverse().find(m => m.info.role === 'assistant')
    if (!lastAssistant) return
    const text = lastAssistant.parts
      .filter(part => part.type === 'text')
      .map(part => (part as { text: string }).text)
      .join('')
    if (text) {
      try {
        await copyTextToClipboard(text)
      } catch (err) {
        clipboardErrorHandler('copy last response', err)
      }
    }
  }, [messages])

  const clearRestoredContent = useCallback(() => {
    setRestoredContent(null)
    clearRevert()
  }, [clearRevert])

  const activeRestoredContent = useMemo(() => {
    if (!restoredContent || restoredContent.sessionId !== routeSessionId) return null
    return restoredContent.content
  }, [restoredContent, routeSessionId])

  const handleVisibleMessageIdsChange = useCallback((_ids: string[]) => {}, [])

  const refreshSessionFromHost = useCallback(async (sessionId: string) => {
    // dsh: 历史重拉（用于断线重连兜底，协议 §21 无 replay）
    await useDshStore.getState().openSession(splitSessionKey(sessionId).sessionId)
  }, [])

  const openHostSession = useCallback(async (rawSessionId: string) => {
    const store = useDshStore.getState()
    const session = store.sessions.find(item => item.sessionId === rawSessionId)
    const sessionKey = store.selectedDevice !== undefined
      ? makeSessionKey(store.selectedDevice.deviceId, rawSessionId)
      : rawSessionId
    navigateToSession(sessionKey, session ? remoteSessionToApiSession(session).directory : undefined)
  }, [navigateToSession])

  return {
    // State
    messages,
    isStreaming: isSessionBusy,
    messageIsStreaming: isStreaming,
    sessionDirectory,
    canUndo: false,
    canRedo: false,
    redoSteps: 0,
    revertedContent: null,
    restoredContent: activeRestoredContent,
    loadState,
    loadError,
    hasMoreHistory,
    retryStatus,
    agents: [] as ApiAgent[],
    selectedAgent: '',
    setSelectedAgent: (_agentName: string) => {},
    routeSessionId,
    effectiveDirectory,

    // Permissions
    pendingPermissionRequests,
    pendingQuestionRequests,
    queuedFollowups,
    queuedFollowupSendingId,
    handlePermissionReply,
    handleQuestionReply,
    handleQuestionReject,
    isReplying,

    // Session management
    loadMoreHistory,
    handleRedoAll,
    clearRevert: clearRestoredContent,
    refreshSessionFromHost,
    openHostSession,

    // Animation
    registerMessage,
    registerInputBox,

    // Handlers
    handleSend,
    handleAbort,
    handleCommand,
    handleUndoWithAnimation,
    handleRedoWithAnimation,
    handleForkMessage,
    handleSelectSession,
    handleNewSession,
    handleVisibleMessageIdsChange,
    handleArchiveSession,
    handlePreviousSession,
    handleNextSession,
    handleCopyLastResponse,
    restoreAgentFromMessage: (_agentName: string | null | undefined) => {},
  }
}

// ============================================
// helpers
// ============================================
