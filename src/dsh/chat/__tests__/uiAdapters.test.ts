import { describe, expect, it } from 'vitest'
import { remoteSessionToApiSession } from '../uiAdapters'
import type { RemoteSession } from '../../types'

function createSession(overrides: Partial<RemoteSession> = {}): RemoteSession {
  return {
    sessionId: 'session-3a98c125-2d2f-40c5-a6e6-ce4cc90c75a2',
    updatedAt: 1,
    running: false,
    blank: false,
    ...overrides,
  }
}

describe('remoteSessionToApiSession', () => {
  it('uses the host title when present', () => {
    const api = remoteSessionToApiSession(createSession({ title: '对话命名与工作区功能问题' }))
    expect(api.title).toBe('对话命名与工作区功能问题')
    expect(api.id).toBe('session-3a98c125-2d2f-40c5-a6e6-ce4cc90c75a2')
  })

  it('labels blank sessions as New session', () => {
    expect(remoteSessionToApiSession(createSession({ blank: true })).title).toBe('New session')
  })

  it('derives the fallback title from the id suffix, not the shared session- prefix', () => {
    // Host ids all start with the literal `session-`; slicing the head made every
    // conversation read "Session sessio".
    const api = remoteSessionToApiSession(createSession())
    expect(api.title).toBe('Session 3a98c125')
  })

  it('keeps a usable fallback when the id has no session- prefix', () => {
    const api = remoteSessionToApiSession(createSession({ sessionId: 'abc123def456' }))
    expect(api.title).toBe('Session abc123de')
  })

  it('prefers the session cwd and falls back to the host cwd', () => {
    expect(remoteSessionToApiSession(createSession({ cwd: 'D:\\Projects\\DSH-Remote' })).directory)
      .toBe('D:\\Projects\\DSH-Remote')
    expect(remoteSessionToApiSession(createSession(), 'D:\\Host').directory).toBe('D:\\Host')
  })
})
