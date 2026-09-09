// Tests for the ChatItem → Message adapter (plan D3).
import { describe, expect, it } from 'vitest'
import { chatItemsToMessages } from '../toUiMessages'
import type { ChatItem, ChatMessage, ToolActivity } from '../../types'

function userMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    kind: 'message',
    id: 'u1',
    sessionId: 's1',
    role: 'user',
    text: 'hello',
    createdAt: 1000,
    ...overrides,
  }
}

function assistantMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    kind: 'message',
    id: 'a1',
    sessionId: 's1',
    role: 'assistant',
    text: 'world',
    createdAt: 2000,
    ...overrides,
  }
}

function toolActivity(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    kind: 'tool',
    id: 't1',
    sessionId: 's1',
    toolName: 'Bash',
    state: 'running',
    createdAt: 3000,
    ...overrides,
  }
}

describe('chatItemsToMessages', () => {
  it('converts a user message with stable part ids', () => {
    const [message] = chatItemsToMessages([userMessage()])
    expect(message).toBeDefined()
    expect(message!.info.role).toBe('user')
    expect(message!.info.sessionID).toBe('s1')
    expect(message!.parts).toHaveLength(1)
    expect(message!.parts[0]).toMatchObject({ type: 'text', text: 'hello', id: 'u1:0' })
  })

  it('converts an assistant message with reasoning before text', () => {
    const [message] = chatItemsToMessages([assistantMessage({ reasoning: 'thinking', text: 'answer' })])
    expect(message!.info.role).toBe('assistant')
    expect(message!.parts.map(part => part.type)).toEqual(['reasoning', 'text'])
    expect(message!.parts[1]).toMatchObject({ text: 'answer', id: 'a1:2' })
  })

  it('marks streaming assistant rows as streaming with no completed time', () => {
    const [message] = chatItemsToMessages([assistantMessage({ streaming: true })])
    expect(message!.isStreaming).toBe(true)
    expect(message!.info.time.completed).toBeUndefined()
  })

  it('maps tool activities into ToolPart with card metadata', () => {
    const [message] = chatItemsToMessages([
      toolActivity({ summary: 'ls -la', resultDetail: { text: 'file.txt', format: 'code' }, state: 'finished' }),
    ])
    const part = message!.parts[0]
    expect(part.type).toBe('tool')
    if (part.type !== 'tool') return
    expect(part.tool).toBe('Bash')
    expect(part.state.status).toBe('completed')
    expect(part.state.output).toBe('file.txt')
    expect(part.state.metadata?.dshSummary).toBe('ls -la')
  })

  it('maps failed tool calls to the error state', () => {
    const [message] = chatItemsToMessages([toolActivity({ state: 'failed' })])
    const part = message!.parts[0]
    if (part.type !== 'tool') return
    expect(part.state.status).toBe('error')
  })

  it('keeps image placeholders as file parts on user rows', () => {
    const [message] = chatItemsToMessages([userMessage({ text: '', images: [{ name: 'shot.png' }] })])
    expect(message!.parts).toHaveLength(1)
    expect(message!.parts[0].type).toBe('file')
  })

  it('skips approval and question items (they render through the permission UI)', () => {
    const items: ChatItem[] = [
      userMessage(),
      {
        kind: 'approval',
        id: 'approval:a1',
        sessionId: 's1',
        approvalId: 'a1',
        toolName: 'Bash',
        frameRpcId: 'rpc-1',
        createdAt: 4000,
      },
    ]
    const messages = chatItemsToMessages(items)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.info.id).toBe('u1')
  })

  it('projects a full transcript in order', () => {
    const items: ChatItem[] = [
      userMessage({ id: 'u1' }),
      toolActivity({ id: 't1' }),
      assistantMessage({ id: 'a1' }),
    ]
    const messages = chatItemsToMessages(items)
    expect(messages.map(message => message.info.id)).toEqual(['u1', 't1', 'a1'])
  })

  it('reuses the same Message object for an unchanged ChatItem (structural sharing)', () => {
    const user = userMessage()
    const tool = toolActivity({ state: 'running' })
    const assistant = assistantMessage({ streaming: true })

    const first = chatItemsToMessages([user, tool, assistant])
    // 模拟一帧流式 delta：只有 assistant 变成新对象，其余 item 引用不变
    const updatedAssistant = assistantMessage({ streaming: true, text: 'world!' })
    const second = chatItemsToMessages([user, tool, updatedAssistant])

    expect(second[0]).toBe(first[0])
    expect(second[1]).toBe(first[1])
    expect(second[2]).not.toBe(first[2])
  })
})
