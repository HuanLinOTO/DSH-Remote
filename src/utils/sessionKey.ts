// ============================================
// Session Key - 服务器作用域的会话标识
//
// 复合格式: `${serverId}::${sessionId}`
// pane / messageStore / childSessionStore 等内部一律使用复合 key，
// API 调用前通过 splitSessionKey 解析出 serverId。
// ============================================

import { serverStore } from '../store/serverStore'

const SEPARATOR = '::'

/**
 * 合成服务器作用域的会话 key
 */
export function makeSessionKey(serverId: string, sessionId: string): string {
  return `${serverId}${SEPARATOR}${sessionId}`
}

/**
 * 从复合 key 解析出 serverId 与原始 sessionId。
 * 不带 server 前缀的旧 key 视为活动服务器。
 */
export function splitSessionKey(sessionKey: string): { serverId: string; sessionId: string } {
  const idx = sessionKey.indexOf(SEPARATOR)
  if (idx === -1) {
    return { serverId: serverStore.getActiveServerId(), sessionId: sessionKey }
  }
  return { serverId: sessionKey.slice(0, idx), sessionId: sessionKey.slice(idx + SEPARATOR.length) }
}

/**
 * 从复合 key 中提取 serverId
 */
export function sessionKeyToServerId(sessionKey: string): string {
  return splitSessionKey(sessionKey).serverId
}

/**
 * 从复合 key 中提取原始 sessionId
 */
export function sessionKeyToSessionId(sessionKey: string): string {
  return splitSessionKey(sessionKey).sessionId
}

/**
 * 解析 API 调用的目标：sessionId 可以是复合 key（serverId::sessionId）或原始 id。
 * 显式 serverId 优先；否则从复合 key 解析；两者都缺时用活动服务器。
 */
export function resolveSessionTarget(sessionId: string, serverId?: string): { sessionId: string; serverId: string } {
  const parsed = splitSessionKey(sessionId)
  return { sessionId: parsed.sessionId, serverId: serverId ?? parsed.serverId }
}
