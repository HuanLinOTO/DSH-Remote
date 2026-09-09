import type { ActiveSessionEntry } from '../../../store/activeSessionStore'
import { splitSessionKey } from '../../../utils/sessionKey'

export interface ActiveSessionTree {
  rootEntries: ActiveSessionEntry[]
  childrenByParent: Map<string, ActiveSessionEntry[]>
}

export function buildActiveSessionTree(
  busySessions: ActiveSessionEntry[],
  findParentId: (sessionId: string) => string | undefined,
): ActiveSessionTree {
  // 树统一用原始 id 作为 key：findParentId 返回原始 parentID，busySessions 的 entry.sessionId 是复合 key
  const busyRawIds = new Set(busySessions.map(entry => splitSessionKey(entry.sessionId).sessionId))
  const rootEntries: ActiveSessionEntry[] = []
  const childrenByParent = new Map<string, ActiveSessionEntry[]>()

  for (const entry of busySessions) {
    const parentId = findParentId(entry.sessionId)

    if (!parentId || !busyRawIds.has(parentId)) {
      rootEntries.push(entry)
      continue
    }

    const siblings = childrenByParent.get(parentId)
    if (siblings) {
      siblings.push(entry)
    } else {
      childrenByParent.set(parentId, [entry])
    }
  }

  return { rootEntries, childrenByParent }
}
