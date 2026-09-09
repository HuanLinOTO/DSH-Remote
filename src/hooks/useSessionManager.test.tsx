import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const loadOlderHistory = vi.fn().mockResolvedValue(undefined)
const openSession = vi.fn().mockResolvedValue(true)

vi.mock('../dsh/chat/sessionStore', () => ({
  useDshStore: { getState: () => ({ loadOlderHistory, openSession }) },
}))

import { useSessionManager } from './useSessionManager'

describe('useSessionManager history paging', () => {
  beforeEach(() => {
    loadOlderHistory.mockClear()
    openSession.mockClear()
  })

  it('pages the pane route session instead of guessing one from the session list', async () => {
    const { result } = renderHook(() => useSessionManager({ sessionId: 'local::session-abc' }))

    await act(async () => {
      await result.current.loadMoreHistory()
    })

    expect(loadOlderHistory).toHaveBeenCalledWith('session-abc')
  })

  it('no-ops when the pane has no route session', async () => {
    const { result } = renderHook(() => useSessionManager({ sessionId: null }))

    await act(async () => {
      await result.current.loadMoreHistory()
    })

    expect(loadOlderHistory).not.toHaveBeenCalled()
  })
})
