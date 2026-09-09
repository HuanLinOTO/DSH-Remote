// Tests for the bridge UI-sync scheduler (streaming push throttle).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSyncScheduler } from '../bridge'

describe('createSyncScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces bursts into a single flush per interval', () => {
    const flush = vi.fn()
    const scheduler = createSyncScheduler(flush, 100)

    scheduler.schedule('s1')
    scheduler.schedule('s1')
    scheduler.schedule('s1')
    expect(flush).not.toHaveBeenCalled()

    vi.advanceTimersByTime(100)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalledWith('s1')
  })

  it('flushes different sessions independently', () => {
    const flush = vi.fn()
    const scheduler = createSyncScheduler(flush, 100)

    scheduler.schedule('a')
    vi.advanceTimersByTime(50)
    scheduler.schedule('b')
    vi.advanceTimersByTime(100)

    expect(flush).toHaveBeenCalledTimes(2)
    expect(flush).toHaveBeenNthCalledWith(1, 'a')
    expect(flush).toHaveBeenNthCalledWith(2, 'b')
  })

  it('allows a new schedule after the interval elapses', () => {
    const flush = vi.fn()
    const scheduler = createSyncScheduler(flush, 100)

    scheduler.schedule('s1')
    vi.advanceTimersByTime(100)
    expect(flush).toHaveBeenCalledTimes(1)

    scheduler.schedule('s1')
    vi.advanceTimersByTime(100)
    expect(flush).toHaveBeenCalledTimes(2)
  })

  it('cancelAll drops pending flushes', () => {
    const flush = vi.fn()
    const scheduler = createSyncScheduler(flush, 100)

    scheduler.schedule('s1')
    scheduler.cancelAll()
    vi.advanceTimersByTime(500)
    expect(flush).not.toHaveBeenCalled()
  })

  it('uses the injected timer handles', () => {
    const scheduled: Array<{ cb: () => void; ms: number }> = []
    const cancelled: unknown[] = []
    const flush = vi.fn()
    const scheduler = createSyncScheduler(
      flush,
      250,
      (cb, ms) => {
        scheduled.push({ cb, ms })
        return scheduled.length
      },
      handle => cancelled.push(handle),
    )

    scheduler.schedule('s1')
    expect(scheduled).toEqual([{ cb: expect.any(Function), ms: 250 }])
    scheduler.cancelAll()
    expect(cancelled).toEqual([1])
  })
})
