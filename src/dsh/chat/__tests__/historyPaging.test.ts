import { beforeEach, describe, expect, it, vi } from 'vitest'

// session.history 的翻页游标必须是「每会话一份」：早先 store 只存一份全局
// oldestLoadedSeq/historyHasMore，后打开的会话会把前面会话的游标冲掉，
// 于是前面那个会话永远翻不动页（表现为只剩一个没有 user 锚点的过程壳）。
const sessionHistory = vi.fn()

vi.mock('../../connection/connection', () => ({
  DshRemoteConnection: class {
    requireProxy() {
      return {
        sessionHistory,
        sessionModels: vi.fn().mockResolvedValue({ current: undefined, options: [] }),
      }
    }
    async close() {}
  },
}))

import { useDshStore } from '../sessionStore'
import type { HistoryEntry, NativeSessionEvent } from '../../types'

function sessionEvent(partial: Partial<NativeSessionEvent> & Pick<NativeSessionEvent, 'type' | 'data'>): NativeSessionEvent {
  return { seq: 0, time: 1_700_000_000_000, ...partial }
}

function entry(event: NativeSessionEvent): HistoryEntry {
  return { event }
}

function userEntry(seq: number, id: string, text: string): HistoryEntry {
  return entry(sessionEvent({
    type: 'user/message',
    seq,
    data: { message: { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } },
  }))
}

function assistantEntry(seq: number, id: string, text: string): HistoryEntry {
  return entry(sessionEvent({
    type: 'assistant/message',
    seq,
    data: { turn: 1, step: 1, message: { id, role: 'assistant', content: [{ type: 'text', text }] } },
  }))
}

describe('session history paging cursors', () => {
  beforeEach(() => {
    sessionHistory.mockReset()
    useDshStore.setState({ chatItems: {}, historyCursors: {}, error: undefined, busyAction: undefined })
  })

  it('keeps one cursor per session and pages the session that asked', async () => {
    sessionHistory.mockResolvedValueOnce({
      events: [assistantEntry(150, 'a-150', 'later assistant')],
      hasMore: true,
    })
    await useDshStore.getState().openSession('A')

    sessionHistory.mockResolvedValueOnce({
      events: [assistantEntry(0, 'b-0', 'other session')],
      hasMore: false,
    })
    await useDshStore.getState().openSession('B')

    // 打开 B 不得覆盖 A 的游标（旧实现的全局字段正是在这里被冲掉的）
    expect(useDshStore.getState().historyCursors.A).toEqual({ oldestSeq: 150, hasMore: true, loadingOlder: false })
    expect(useDshStore.getState().historyCursors.B).toEqual({ oldestSeq: 0, hasMore: false, loadingOlder: false })

    sessionHistory.mockResolvedValueOnce({
      events: [userEntry(11, 'a-11', 'the prompt'), assistantEntry(14, 'a-14', 'earlier assistant')],
      hasMore: false,
    })
    await useDshStore.getState().loadOlderHistory('A')

    expect(sessionHistory).toHaveBeenLastCalledWith('A', 150, 60)
    const items = useDshStore.getState().chatItems.A ?? []
    expect(items).toHaveLength(3)
    expect(items[0]).toMatchObject({ kind: 'message', id: 'a-11', role: 'user', text: 'the prompt' })
    expect(items[2]).toMatchObject({ kind: 'message', id: 'a-150' })
    expect(useDshStore.getState().historyCursors.A).toEqual({ oldestSeq: 11, hasMore: false, loadingOlder: false })
    // 其他会话的条目不受影响
    expect(useDshStore.getState().chatItems.B).toHaveLength(1)
  })

  it('does nothing for unknown sessions, exhausted cursors or a page already in flight', async () => {
    await useDshStore.getState().loadOlderHistory('missing')
    expect(sessionHistory).not.toHaveBeenCalled()

    sessionHistory.mockResolvedValueOnce({ events: [assistantEntry(150, 'a-150', 'later assistant')], hasMore: false })
    await useDshStore.getState().openSession('A')

    await useDshStore.getState().loadOlderHistory('A')
    expect(sessionHistory).toHaveBeenCalledTimes(1)

    useDshStore.setState(state => ({
      historyCursors: { ...state.historyCursors, A: { ...state.historyCursors.A!, hasMore: true, loadingOlder: true } },
    }))
    await useDshStore.getState().loadOlderHistory('A')
    expect(sessionHistory).toHaveBeenCalledTimes(1)
  })

  it('clears cursors on disconnect', async () => {
    sessionHistory.mockResolvedValueOnce({ events: [assistantEntry(150, 'a-150', 'later assistant')], hasMore: true })
    await useDshStore.getState().openSession('A')
    await useDshStore.getState().disconnect()
    expect(useDshStore.getState().historyCursors).toEqual({})
  })
})
