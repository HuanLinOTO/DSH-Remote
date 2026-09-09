// ChatItem → UI Message/Part adapter (plan D3).
// ChatItem is the source of truth from the dsh event-reducer; this pure
// projection feeds messageStore with the Message{info, parts[]} shape the
// existing renderer consumes. Approvals/questions are NOT converted — the
// permission/question UI reads them directly from the dsh session store.

import type { Message, Part, TextPart, ReasoningPart, ToolPart, FilePart, AssistantMessageInfo, UserMessageInfo } from '../../types/message'
import type { ChatItem, ChatMessage, ToolActivity, ImageMediaType } from '../types'

const IMAGE_MIME_PREFIX = 'image/'

function timeInfo(item: ChatItem): { created: number; completed?: number } {
  const streaming = item.kind === 'message' && item.streaming === true
  return streaming ? { created: item.createdAt } : { created: item.createdAt, completed: item.createdAt }
}

function baseAssistantInfo(item: ChatItem): AssistantMessageInfo {
  return {
    id: item.id,
    sessionID: item.sessionId,
    role: 'assistant',
    time: timeInfo(item),
    parentID: '',
    modelID: '',
    providerID: '',
    mode: '',
    agent: '',
    path: { cwd: '', root: '' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

function userItemToUiMessage(item: ChatMessage): Message {
  const info: UserMessageInfo = {
    id: item.id,
    sessionID: item.sessionId,
    role: 'user',
    time: timeInfo(item),
    agent: '',
    model: { providerID: '', modelID: '' },
  }
  const parts: Part[] = []
  if (item.text.length > 0) {
    parts.push({
      id: `${item.id}:0`,
      type: 'text',
      text: item.text,
      synthetic: false,
      sessionID: item.sessionId,
      messageID: item.id,
    } satisfies TextPart)
  }
  for (const [index, image] of (item.images ?? []).entries()) {
    parts.push({
      id: `${item.id}:${parts.length + index + 1}`,
      type: 'file',
      mime: 'image/png',
      filename: image.name,
      url: image.url ?? '',
      sessionID: item.sessionId,
      messageID: item.id,
    } satisfies FilePart)
  }
  return { info, parts, isStreaming: false }
}

function assistantItemToUiMessage(item: ChatMessage): Message {
  const info = baseAssistantInfo(item)
  const parts: Part[] = []
  if (item.reasoning !== undefined && item.reasoning.length > 0) {
    parts.push({
      id: `${item.id}:0`,
      type: 'reasoning',
      text: item.reasoning,
      time: { start: item.createdAt },
      sessionID: item.sessionId,
      messageID: item.id,
    } satisfies ReasoningPart)
  }
  if (item.text.length > 0) {
    parts.push({
      id: `${item.id}:${parts.length + 1}`,
      type: 'text',
      text: item.text,
      synthetic: false,
      sessionID: item.sessionId,
      messageID: item.id,
    } satisfies TextPart)
  }
  return { info, parts, isStreaming: item.streaming === true }
}

function toolItemToUiMessage(item: ToolActivity): Message {
  const info = baseAssistantInfo(item)
  const status: 'pending' | 'running' | 'completed' | 'error'
    = item.state === 'running' ? 'running' : item.state === 'failed' ? 'error' : 'completed'
  const detail = item.state === 'running' ? item.callDetail : item.resultDetail
  const part: ToolPart = {
    id: `${item.id}:0`,
    type: 'tool',
    callID: item.id,
    tool: item.toolName,
    state: {
      status,
      input: {},
      ...(item.arguments !== undefined ? { raw: item.arguments } : {}),
      ...(status === 'error'
        ? { error: item.summary ?? detail?.text ?? 'The tool call failed.' }
        : {
            ...(item.summary !== undefined ? { title: item.summary } : {}),
            output: detail?.text ?? '',
          }),
      time: { start: item.createdAt, ...(status !== 'running' ? { end: item.createdAt } : {}) },
      metadata: {
        dshToolName: item.toolName,
        ...(item.summary !== undefined ? { dshSummary: item.summary } : {}),
        ...(detail !== undefined ? { dshDetail: detail.text, dshDetailFormat: detail.format, ...(detail.truncated === true ? { dshDetailTruncated: true } : {}) } : {}),
      },
    },
    sessionID: item.sessionId,
    messageID: item.id,
  }
  return { info, parts: [part], isStreaming: item.state === 'running' }
}

/**
 * 逐项投影缓存：event-reducer 是不可变更新（流式 delta 产生新 item、未变 item
 * 引用稳定），所以同一 ChatItem 引用永远映射同一 Message。bridge 每帧重投影时，
 * 未变化的行直接复用对象，下游（可见性合并 / 过程时间线 / VirtualRow memo）的
 * 结构化共享才能命中 —— 否则长会话流式期间每帧重建整棵消息树，渲染被拖死。
 */
const uiMessageCache = new WeakMap<ChatItem, Message>()

function itemToUiMessage(item: ChatItem & { kind: 'message' | 'tool' }): Message {
  const cached = uiMessageCache.get(item)
  if (cached) return cached
  const message = item.kind === 'message'
    ? (item.role === 'assistant' ? assistantItemToUiMessage(item) : userItemToUiMessage(item))
    : toolItemToUiMessage(item)
  uiMessageCache.set(item, message)
  return message
}

/** Project ordered chat items into UI messages; approval/question items are skipped. */
export function chatItemsToMessages(items: ChatItem[]): Message[] {
  const messages: Message[] = []
  for (const item of items) {
    if (item.kind === 'message' || item.kind === 'tool') {
      messages.push(itemToUiMessage(item))
    }
    // approval/question render through the permission/question UI
  }
  return messages
}

export function isImageMediaType(value: string): value is ImageMediaType {
  return value.startsWith(IMAGE_MIME_PREFIX)
}
