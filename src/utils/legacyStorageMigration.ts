// OpenCodeUI → DSH Remote 一次性存储迁移。
// 旧版本用 `opencode*` 前缀的 localStorage 键 / IndexedDB 库名;这里在应用启动时
// 把旧数据搬到 `dsh*` 命名下(新键已存在时以新键为准),然后删除旧键。
// 全部静默失败:迁移出错只影响旧数据延续,不影响应用启动。

const LEGACY_KEY_PAIRS: ReadonlyArray<readonly [legacyKey: string, nextKey: string]> = [
  ['opencode-saved-directories', 'dsh-saved-directories'],
  ['opencode-recent-projects', 'dsh-recent-projects'],
  ['opencode-servers', 'dsh-servers'],
  ['opencode-active-server', 'dsh-active-server'],
  ['opencode-multi-server', 'dsh-multi-server'],
  ['opencode-auto-approve-enabled', 'dsh-auto-approve-enabled'],
  ['opencode-approve-pending-on-full-auto', 'dsh-approve-pending-on-full-auto'],
  ['opencode-keybindings', 'dsh-keybindings'],
  ['opencode-path-mode', 'dsh-path-mode'],
  ['opencode-detected-path-style', 'dsh-detected-path-style'],
  ['opencode-wake-lock', 'dsh-wake-lock'],
  ['opencode-sidebar-expanded', 'dsh-sidebar-expanded'],
  ['opencode-sidebar-folder-recents', 'dsh-sidebar-folder-recents'],
  ['opencode-sidebar-folder-recents-show-diff', 'dsh-sidebar-folder-recents-show-diff'],
  ['opencode-sidebar-show-child-sessions', 'dsh-sidebar-show-child-sessions'],
  ['opencode-sidebar-global-folder-index', 'dsh-sidebar-global-folder-index'],
  ['opencode-panel-layout', 'dsh-panel-layout'],
  ['opencode-terminal-layout', 'dsh-terminal-layout'],
  ['opencode-right-panel-width', 'dsh-right-panel-width'],
  ['opencode-bottom-panel-height', 'dsh-bottom-panel-height'],
  ['opencode-terminal-copy-on-select', 'dsh-terminal-copy-on-select'],
  ['opencode-terminal-right-click-paste', 'dsh-terminal-right-click-paste'],
  ['opencode-pinned-sessions', 'dsh-pinned-sessions'],
  ['opencode:sound-settings', 'dsh:sound-settings'],
  ['opencode:notifications', 'dsh:notifications'],
  ['opencode:toast-enabled', 'dsh:toast-enabled'],
  ['opencode:notification-event-settings', 'dsh:notification-event-settings'],
]

/** per-server 键格式 `srv:{serverId}:{key}`,旧后缀 `opencode-*` → `dsh-*`。 */
const LEGACY_PER_SERVER_KEY = /^srv:(.+):opencode-(.+)$/

function moveKey(legacyKey: string, nextKey: string): void {
  const legacyValue = localStorage.getItem(legacyKey)
  if (legacyValue == null) return
  if (localStorage.getItem(nextKey) == null) {
    localStorage.setItem(nextKey, legacyValue)
  }
  localStorage.removeItem(legacyKey)
}

export function migrateLegacyStorageKeys(): void {
  try {
    for (const [legacyKey, nextKey] of LEGACY_KEY_PAIRS) {
      moveKey(legacyKey, nextKey)
    }

    // per-server 键:serverId 任意,只能扫描匹配
    const perServerMoves: Array<readonly [string, string]> = []
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key == null) continue
      const match = LEGACY_PER_SERVER_KEY.exec(key)
      if (match) perServerMoves.push([key, `srv:${match[1]}:dsh-${match[2]}`])
    }
    for (const [legacyKey, nextKey] of perServerMoves) {
      moveKey(legacyKey, nextKey)
    }
  } catch {
    // 存储不可用(隐私模式等)时放弃迁移
  }
}

// ─── 旧自定义提示音库迁移:opencode-sounds(custom-audio: key→Blob)→ dsh-sounds ───

const LEGACY_SOUNDS_DB = 'opencode-sounds'
const SOUNDS_DB = 'dsh-sounds'
const SOUNDS_STORE = 'custom-audio'

function idbRequestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function migrateLegacySoundsDb(): Promise<void> {
  // 单次定时兜底:IDB 卡死不阻塞启动
  await Promise.race([
    (async () => {
      try {
        const legacyDb = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(LEGACY_SOUNDS_DB)
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
          request.onblocked = () => reject(new Error('blocked'))
          request.onupgradeneeded = () => {
            // 旧库不存在时 open 会走 upgrade 建空库 —— 直接关闭并删除
            request.transaction?.abort()
          }
        })
        try {
          if (!legacyDb.objectStoreNames.contains(SOUNDS_STORE)) return
          const tx = legacyDb.transaction(SOUNDS_STORE, 'readonly')
          const store = tx.objectStore(SOUNDS_STORE)
          const [keys, values] = await Promise.all([
            idbRequestToPromise(store.getAllKeys()),
            idbRequestToPromise(store.getAll()),
          ])
          if (keys.length === 0) return
          const nextDb = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(SOUNDS_DB, 1)
            request.onupgradeneeded = () => {
              const db = request.result
              if (!db.objectStoreNames.contains(SOUNDS_STORE)) {
                db.createObjectStore(SOUNDS_STORE)
              }
            }
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
          })
          try {
            const writeTx = nextDb.transaction(SOUNDS_STORE, 'readwrite')
            const writeStore = writeTx.objectStore(SOUNDS_STORE)
            for (let index = 0; index < keys.length; index += 1) {
              writeStore.put(values[index], keys[index])
            }
            await new Promise<void>((resolve, reject) => {
              writeTx.oncomplete = () => resolve()
              writeTx.onerror = () => reject(writeTx.error)
              writeTx.onabort = () => reject(writeTx.error)
            })
            indexedDB.deleteDatabase(LEGACY_SOUNDS_DB)
          } finally {
            nextDb.close()
          }
        } finally {
          legacyDb.close()
        }
      } catch {
        // 旧库不存在 / 迁移失败:静默跳过,新库从空开始
      }
    })(),
    new Promise<void>(resolve => setTimeout(resolve, 3000)),
  ])
}
