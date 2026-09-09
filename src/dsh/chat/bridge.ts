// Bridge: dsh chatItems (event-reducer output) → messageStore Message feed.
// Subscribes to the dsh session store and pushes converted messages into the
// existing per-session message cache so all UI renderers keep working.

import { messageStore } from '../../store/messageStore'
import { serverStore } from '../../store/serverStore'
import { makeSessionKey } from '../../utils/sessionKey'
import { chatItemsToMessages } from './toUiMessages'
import { useDshStore } from './sessionStore'
import type { ChatItem } from '../types'

const lastItems = new Map<string, ChatItem[]>()
/** 每个会话上次推给 messageStore 的 isStreaming 值（UI key 记账） */
const lastStreaming = new Map<string, boolean>()

/**
 * messageStore / 路由使用「serverId::sessionId」复合 key（App.handleSelectSession
 * 以活动服务器为 dsh 会话加前缀）；dsh store 内部用裸 id。这里是唯一的转换点 ——
 * 用裸 id 写 messageStore 会让 UI 永远读不到消息（loadState 卡在 loading）。
 */
function uiSessionKey(sessionId: string): string {
  return makeSessionKey(serverStore.getActiveServerId(), sessionId)
}

function sessionIsStreaming(rawSessionId: string): boolean {
  const state = useDshStore.getState()
  const session = state.sessions.find(entry => entry.sessionId === rawSessionId)
  const last = state.chatItems[rawSessionId]?.at(-1)
  return session?.running === true
    || (last?.kind === 'message' && last.streaming === true)
    || (last?.kind === 'tool' && last.state === 'running')
}

function syncSession(rawSessionId: string, items: ChatItem[]): void {
  const sessionId = uiSessionKey(rawSessionId)
  if (lastItems.get(sessionId) === items) return
  lastItems.set(sessionId, items)

  const streaming = sessionIsStreaming(rawSessionId)
  lastStreaming.set(sessionId, streaming)

  const state = useDshStore.getState()
  const session = state.sessions.find(entry => entry.sessionId === rawSessionId)
  messageStore.setDshMessages(sessionId, chatItemsToMessages(items), {
    isStreaming: streaming,
    hasMoreHistory: state.historyCursors[rawSessionId]?.hasMore ?? false,
    title: session?.title,
  })
}

/**
 * 流式推送节流：一条长回复以 token 级频率产生 assistant/chunk delta，每个 delta
 * 都会触发 store → bridge → messageStore → React 全链路（流式行的 Markdown 还要
 * 对不断变长的全文重新解析）。按全速推送会让渲染线程被 token 风暴打满（表现为
 * 整页卡死）。reducer 仍然逐帧折叠保证数据完整；这里只把 UI 推送合并到
 * ~10fps，flush 时读 store 里的最新 items。
 */
export const UI_SYNC_INTERVAL_MS = 100

export function createSyncScheduler(
  flush: (rawSessionId: string) => void,
  intervalMs = UI_SYNC_INTERVAL_MS,
  scheduleTimer: (callback: () => void, ms: number) => unknown = (callback, ms) => setTimeout(callback, ms),
  cancelTimer: (handle: unknown) => void = handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
): {
  schedule: (rawSessionId: string) => void
  cancelAll: () => void
} {
  const pending = new Map<string, unknown>()
  return {
    schedule(rawSessionId: string) {
      if (pending.has(rawSessionId)) return
      pending.set(rawSessionId, scheduleTimer(() => {
        pending.delete(rawSessionId)
        flush(rawSessionId)
      }, intervalMs))
    },
    cancelAll() {
      for (const timer of pending.values()) cancelTimer(timer)
      pending.clear()
    },
  }
}

const scheduler = createSyncScheduler(rawSessionId => {
  const latest = useDshStore.getState().chatItems[rawSessionId]
  if (latest !== undefined) syncSession(rawSessionId, latest)
})

function syncAll(): void {
  const state = useDshStore.getState()
  const liveKeys = new Set<string>()
  for (const [rawSessionId, items] of Object.entries(state.chatItems)) {
    const key = uiSessionKey(rawSessionId)
    liveKeys.add(key)
    if (!lastItems.has(key)) {
      // 会话首帧立即推送，避免打开会话时空窗
      syncSession(rawSessionId, items)
      continue
    }
    if (lastItems.get(key) !== items) {
      // 流式期间走节流：flush 时读 store 最新 items，token 风暴合并为 ~10fps
      scheduler.schedule(rawSessionId)
      continue
    }
    // chatItems 未变但 running 状态翻转（流式开始/结束边界）→ 立即推送
    const running = state.sessions.some(entry => entry.sessionId === rawSessionId && entry.running === true)
    if (lastStreaming.has(key) && lastStreaming.get(key) !== running) {
      syncSession(rawSessionId, items)
    }
  }
  // drop caches for sessions removed from the store（lastItems 以 UI 复合 key 记账）
  for (const sessionId of [...lastItems.keys()]) {
    if (!liveKeys.has(sessionId)) {
      lastItems.delete(sessionId)
      lastStreaming.delete(sessionId)
      messageStore.clearSession(sessionId)
    }
  }
}

let unsubscribe: (() => void) | undefined

/** Attach the chatItems → messageStore bridge; idempotent. */
export function startDshChatBridge(): void {
  if (unsubscribe !== undefined) return
  unsubscribe = useDshStore.subscribe(syncAll)
}

export function stopDshChatBridge(): void {
  unsubscribe?.()
  unsubscribe = undefined
  scheduler.cancelAll()
  lastItems.clear()
  lastStreaming.clear()
}
