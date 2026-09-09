// dsh-backed compatibility shims for the kept UI components.
// Functions that no longer have a protocol counterpart are honest no-ops or
// derive from the dsh session store.

import type {
  Agent as ApiAgent,
  PathResponse as ApiPath,
  PermissionRequest as ApiPermissionRequest,
  QuestionRequest as ApiQuestionRequest,
  Session as ApiSession,
} from '../types/api'
import type { PermissionReply, QuestionAnswer } from '../types/api'
import type { SessionListParams } from '../types/api/session'
import type { ModelInfo } from '../types/ui'
import { useDshStore } from '../dsh/chat/sessionStore'
import { remoteSessionToApiSession, pendingApprovals, pendingQuestions, approvalToPermissionRequest, questionToApiRequest, sessionModelsToModelInfos } from '../dsh/chat/uiAdapters'
import { splitSessionKey } from '../utils/sessionKey'

// ============================================
// path / project
// ============================================

export async function getPath(_serverId?: string): Promise<ApiPath> {
  const cwd = useDshStore.getState().hostDescriptor?.cwd ?? ''
  return {
    state: cwd,
    config: cwd,
    worktree: cwd,
    directory: cwd,
  } as unknown as ApiPath
}

// ============================================
// sessions
// ============================================

export async function getSessions(params: SessionListParams & Record<string, unknown> = {}, _serverId?: string): Promise<ApiSession[]> {
  void params
  const state = useDshStore.getState()
  const hostCwd = state.hostDescriptor?.cwd
  return state.sessions
    .filter(session => session.origin !== 'subagent' && !session.blank)
    .map(session => remoteSessionToApiSession(session, hostCwd))
}

/** dsh patch support: archive + rename are the session mutations the protocol exposes. */
export async function updateSession(
  sessionId: string,
  patch: { time?: { archived?: number }; title?: string } & Record<string, unknown>,
  _directory?: string,
  _serverId?: string,
): Promise<ApiSession> {
  const rawSessionId = splitSessionKey(sessionId).sessionId
  if (typeof patch?.time?.archived === 'number') {
    await useDshStore.getState().archiveSession(rawSessionId)
  }
  if (typeof patch?.title === 'string' && patch.title.trim().length > 0) {
    await useDshStore.getState().renameSession(rawSessionId, patch.title)
  }
  const state = useDshStore.getState()
  const session = state.sessions.find(item => item.sessionId === rawSessionId)
  if (session === undefined) throw new Error('Session not found.')
  return remoteSessionToApiSession(session, state.hostDescriptor?.cwd)
}

export async function deleteSession(sessionId: string, _directory?: string, _serverId?: string): Promise<void> {
  await useDshStore.getState().archiveSession(splitSessionKey(sessionId).sessionId)
}

export async function getSessionChildren(sessionId: string, _directory?: string, _serverId?: string): Promise<ApiSession[]> {
  void sessionId
  return []
}

export async function forkSession(_sessionId: string, _messageId?: string, _directory?: string, _serverId?: string): Promise<ApiSession> {
  throw new Error('Fork is not supported by the DSH remote protocol.')
}

export async function summarizeSession(_sessionId: string, _model: { providerID: string; modelID: string }, _directory?: string, _serverId?: string): Promise<void> {
  // no compaction RPC in the dsh tunnel (v1)
}

export async function executeCommand(_sessionId: string, _command: string, _args: string, _directory?: string, _serverId?: string): Promise<void> {
  // slash commands are not part of the dsh tunnel (v1)
}

// ============================================
// models
// ============================================

export async function getActiveModels(_directory?: string, _serverId?: string): Promise<ModelInfo[]> {
  return sessionModelsToModelInfos(useDshStore.getState().sessionModels)
}

export async function getSelectableAgents(_directory?: string, _serverId?: string): Promise<ApiAgent[]> {
  void _directory
  void _serverId
  return []
}

// ============================================
// permissions / questions
// ============================================

export async function getPendingPermissions(_sessionId?: string, _directory?: string, _serverId?: string): Promise<ApiPermissionRequest[]> {
  const items = useDshStore.getState().chatItems
  return Object.values(items).flatMap(entry => pendingApprovals(entry).map(approvalToPermissionRequest))
}

export async function getPendingQuestions(_sessionId?: string, _directory?: string, _serverId?: string): Promise<ApiQuestionRequest[]> {
  const items = useDshStore.getState().chatItems
  return Object.values(items).flatMap(entry => pendingQuestions(entry).map(questionToApiRequest))
}

export async function replyPermission(requestId: string, reply: PermissionReply, _patterns?: string[], _directory?: string, _sessionId?: string, _serverId?: string): Promise<void> {
  const outcome = reply === 'reject' ? 'rejected' as const : 'allowed-once' as const
  await useDshStore.getState().respondApproval(requestId, outcome)
}

export async function replyQuestion(requestId: string, answers: QuestionAnswer[], _directory?: string, _serverId?: string): Promise<void> {
  const state = useDshStore.getState()
  const item = findQuestion(state.chatItems, requestId)
  if (item === undefined) return
  const selected: Record<string, string[]> = {}
  item.questions.forEach((question, index) => {
    selected[question.id] = answers[index] ?? []
  })
  await state.respondQuestion(requestId, selected)
}

export async function rejectQuestion(_requestId: string, _directory?: string, _serverId?: string): Promise<void> {
  // dsh has no client-side question rejection (v1)
}

function findQuestion(chatItems: Record<string, import('../dsh/types').ChatItem[]>, requestId: string) {
  for (const entry of Object.values(chatItems)) {
    const found = entry.find(item => item.kind === 'question' && (item.frameRpcId === requestId || item.id === requestId))
    if (found !== undefined && found.kind === 'question') return found
  }
  return undefined
}

// ============================================
// SSE compatibility (kept components subscribe; events now arrive via mux)
// ============================================

type EventCallbacks = Record<string, unknown>

export function subscribeToEvents(_callbacks: EventCallbacks): () => void {
  return () => {}
}

export function subscribeToServerEvents(_serverId: string, _callbacks: EventCallbacks): () => void {
  return () => {}
}

export async function getSessionStatus(_directory?: string, _serverId?: string): Promise<Record<string, unknown>> {
  return {}
}


// ============================================
// connection-state shims (multi-server sidebar)
// ============================================

export interface ConnectionInfo {
  connected: boolean
  state?: string
  rttMs?: number
  mode?: string
}

export function getServerConnectionInfo(_serverId?: string): ConnectionInfo {
  const { connection } = useDshStore.getState()
  return {
    connected: connection.stats.connected,
    rttMs: connection.stats.rttMs,
    mode: connection.stats.mode,
  }
}

export function subscribeToConnectionState(serverIdOrCb: string | undefined | ((info: ConnectionInfo) => void), maybeCb?: (info: ConnectionInfo) => void): () => void {
  const cb = typeof serverIdOrCb === 'function' ? serverIdOrCb : maybeCb!
  const _serverId = typeof serverIdOrCb === 'string' ? serverIdOrCb : undefined
  void _serverId
  const unsubscribe = useDshStore.subscribe(state => {
    cb({
      connected: state.connection.stats.connected,
      state: state.connection.stats.connected ? 'connected' : 'disconnected',
      rttMs: state.connection.stats.rttMs,
      mode: state.connection.stats.mode,
    })
  })
  return unsubscribe
}

export function subscribeToServerConnectionState(_serverId: string, cb: (info: ConnectionInfo) => void): () => void {
  return subscribeToConnectionState(_serverId, cb)
}

export async function getSession(sessionId: string, _directory?: string, _serverId?: string): Promise<ApiSession> {
  const state = useDshStore.getState()
  const session = state.sessions.find(item => item.sessionId === splitSessionKey(sessionId).sessionId)
  if (session === undefined) throw new Error('Session not found.')
  return remoteSessionToApiSession(session, state.hostDescriptor?.cwd)
}

export async function searchFiles(_query: string, _options?: { limit?: number; directory?: string }, _serverId?: string): Promise<string[]> {
  return []
}

export interface FileListNode {
  name: string
  type: 'file' | 'directory'
  path?: string
}

export async function listDirectory(_path: string | undefined, _directory?: string, _serverId?: string): Promise<FileListNode[]> {
  return []
}

export async function getSessionTodos(_sessionId: string, _directory?: string, _serverId?: string): Promise<import('../types/api/event').TodoItem[]> {
  return []
}

export async function getCommands(_directory?: string, _serverId?: string): Promise<Command[]> {
  return []
}

export interface Command {
  name: string
  description?: string
  keybind?: string
  source: 'frontend' | 'api'
}

/** updateSession returns the patched session for call sites that read .title */


// ============================================
// message shims (TaskRenderer / subagent views)
// ============================================

export async function abortSession(_sessionId: string, _directory?: string, _serverId?: string): Promise<void> {
  // dsh: the stop action targets the routed session from the chat hook
}

export async function getSessionMessages(_sessionId: string, _limit?: number, _directory?: string, _serverId?: string): Promise<never[]> {
  return []
}
