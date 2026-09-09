// Adapters: dsh domain objects → UI view shapes.
// Keeps the existing UI components (Sidebar, ModelSelector, PermissionDialog,
// QuestionDialog, ChatArea) working against dsh data.

import type { ApiPermissionRequest, ApiQuestionRequest, ApiSession, ModelInfo, QuestionAnswer, PermissionReply } from '../../api'
import type {
  ApprovalActivity,
  ChatItem,
  ModelSelection,
  QuestionActivity,
  RemoteSession,
  SessionModels,
} from '../types'
import type { ChatMessage } from '../types'

// ============================================
// Sessions sidebar
// ============================================

export function remoteSessionToApiSession(session: RemoteSession, cwd?: string): ApiSession {
  const title = session.title && session.title.length > 0
    ? session.title
    : session.blank
      ? 'New session'
      : `Session ${sessionTitleFallbackId(session.sessionId)}`
  return {
    id: session.sessionId,
    projectID: 'dsh',
    directory: session.cwd ?? cwd ?? '',
    title,
    version: 'dsh',
    time: { created: session.updatedAt, updated: session.updatedAt },
  } as unknown as ApiSession
}

/**
 * Host session ids all share the literal `session-` prefix (e.g.
 * `session-3a98c125-…`), so slicing the head of the id made every fallback
 * title read "Session sessio". Show the unique suffix instead.
 */
function sessionTitleFallbackId(sessionId: string): string {
  const suffix = sessionId.replace(/^session[-_]/i, '')
  return (suffix.length > 0 ? suffix : sessionId).slice(0, 8)
}

export function sessionRunning(session: RemoteSession | undefined): boolean {
  return session?.running === true
}

// ============================================
// Model selector
// ============================================

export function modelSelectionKey(selection: ModelSelection): string {
  return `${selection.provider}:${selection.model}`
}

export function sessionModelsToModelInfos(models: SessionModels | undefined): ModelInfo[] {
  if (models === undefined) return []
  const infos: ModelInfo[] = []
  for (const group of models.groups) {
    for (const model of group.models) {
      infos.push({
        id: model.id,
        name: model.name,
        providerId: group.id,
        providerName: group.name,
        family: group.id,
        contextLimit: 0,
        outputLimit: 0,
        supportsReasoning: model.reasoning !== undefined && model.reasoning.efforts.length > 0,
        supportsImages: true,
        supportsPdf: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsToolcall: true,
        variants: model.reasoning?.efforts.map(effort => effort.id) ?? [],
      })
    }
  }
  return infos
}

export function currentModelSelection(models: SessionModels | undefined): ModelSelection | undefined {
  return models?.current
}

// ============================================
// Permissions (ApprovalActivity → ApiPermissionRequest)
// ============================================

/** Only pending (unanswered) approval items surface in the permission UI. */
export function pendingApprovals(items: ChatItem[] | undefined): ApprovalActivity[] {
  if (items === undefined) return []
  return items.filter((item): item is ApprovalActivity => item.kind === 'approval' && item.outcome === undefined)
}

export function approvalToPermissionRequest(item: ApprovalActivity): ApiPermissionRequest {
  return {
    id: item.id,
    sessionID: item.sessionId,
    permission: item.toolName,
    patterns: item.reason !== undefined ? [item.reason] : [],
    metadata: {},
    always: [],
  }
}

export function permissionReplyToOutcome(reply: PermissionReply): 'allowed-once' | 'rejected' {
  return reply === 'reject' ? 'rejected' : 'allowed-once'
}

// ============================================
// Questions
// ============================================

export function pendingQuestions(items: ChatItem[] | undefined): QuestionActivity[] {
  if (items === undefined) return []
  return items.filter((item): item is QuestionActivity => item.kind === 'question' && item.outcome === undefined)
}

export function questionToApiRequest(item: QuestionActivity): ApiQuestionRequest {
  return {
    id: item.frameRpcId ?? item.id,
    sessionID: item.sessionId,
    questions: item.questions.map(question => ({
      question: question.question,
      header: question.header ?? question.question.slice(0, 30),
      options: (question.options ?? []).map(option => ({
        label: option.label,
        description: option.description ?? '',
      })),
      multiple: question.multiSelect === true,
    })),
  }
}

/** UI QuestionAnswer is `string[]` of selected labels per question. */
export function questionAnswersToDsh(
  item: QuestionActivity,
  answers: QuestionAnswer[],
  customByQuestion?: Record<string, string>,
): { selected: Record<string, string[]>; custom: Record<string, string> } {
  const selected: Record<string, string[]> = {}
  const custom: Record<string, string> = {}
  item.questions.forEach((question, index) => {
    selected[question.id] = answers[index] ?? []
    const customText = customByQuestion?.[question.id]
    if (customText !== undefined && customText.length > 0) custom[question.id] = customText
  })
  return { selected, custom }
}

/** Extract the user-visible text of a chat message item. */
export function chatMessageText(item: ChatMessage): string {
  return item.text
}
