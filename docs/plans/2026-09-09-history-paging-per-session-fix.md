# 会话历史翻页游标按会话隔离 + 首屏自动补页 — 实现记录

日期:2026-09-09
状态:已实现并验证（Android 平板实测通过）

## 现象

打开某个长会话（单回合 83 条消息、耗时 1h27m59s）后，聊天区只显示一行
「已处理 1h 27m 59s ▸」，其余什么都没有：没有用户提问、没有最终回答。

## 根因（三层叠加）

### 1. 首屏历史窗口天然不含 user 锚点

`session.history` 首次调用用 `maxMessages = 60`（`sessionStore.openSession`）。Host 侧
`paginate()` 从后往前数**消息类事件**（user/message + assistant/message）到 60 条为止，
返回 `events.slice(cut, end)` 与 `hasMore = cut > 0`。

该会话共 83 条消息事件（6 user + 77 assistant），窗口因此从第 18 条 assistant 开始
（实测首条消息 `completed = 15:05:10.664`，正是 Host 侧第 18 条 assistant/message 的时间），
6 条 user/message（seq 11–16）全部落在窗口外。

### 2. 无 user 锚点 → 全部消息折进一个折叠壳

`buildProcessTimeline`：没有 user 消息时，所有 assistant 都进 `headOrphans`，
合成一个 `process-shell:head` 壳（`isActive = false` → 默认折叠）。
该窗口最后一条消息是**未完成的 tool 调用**（回合以附件错误中断），
`finalMessage`（壳外最终回答）因此为空 → 时间线只有 1 行折叠壳，展开才看得到内容。

### 3. 翻页游标是全局的，被别的会话冲掉（真正的死结）

`sessionStore` 里 `historyHasMore` / `historyLoadingOlder` / `oldestLoadedSeq` 是**单个全局字段**：

- 打开 A 会话 → 写入 A 的 `oldestLoadedSeq = 150, hasMore = true`；
- 随后另一个窗格打开 B 会话（本例 `session-a32664bc…`，整页加载完）→ 覆盖为
  `oldestLoadedSeq = 0, hasMore = false`；
- 回到 A 会话点「加载更早」→ `loadOlderHistory` 读全局 `hasMore = false` → **直接 return**，
  一个 RPC 都不发（CDP 实测：调用 `onLoadMore()` 后控制帧数为 0，`hasMoreHistory` 仍为 true）。

`useSessionManager.loadMoreHistory` 还按会话列表猜目标会话
（`sessions.find(running) ?? sessions.find(!blank)`），与当前窗格路由会话无关，
多窗格下会翻错会话。

结果：这个会话永远停在没有锚点的折叠壳上，UI 看起来是空的。

## 修复

| 位置 | 改动 |
| --- | --- |
| `sessionStore.ts` | 新增 `historyCursors: Record<sessionId, { oldestSeq?, hasMore, loadingOlder }>`，`openSession` 只写自己的游标，`loadOlderHistory(sessionId)` 读写自己的游标；`disconnect` 清空 |
| `useSessionManager.ts` | `loadMoreHistory` 改用当前窗格路由会话（`splitSessionKey(sessionId).sessionId`），删掉按列表猜目标会话的启发式 |
| `bridge.ts` | 推给 `messageStore` 的 `hasMoreHistory` 取该会话自己的游标 |

修复后：首屏只有折叠壳（内容不足一屏）→ ChatArea 的 `fill()` 自动补页 →
`loadOlderHistory` 用本会话 `beforeSeq = 150` 取回含 user 提问的一页 → 时间线变成
「用户提问 + 已处理壳」，再补一页 `hasMore = false` 收敛。

## 验证

- 新增单测：`src/dsh/chat/__tests__/historyPaging.test.ts`（每会话游标、跨会话不互相覆盖、
  未知会话/已耗尽/加载中不重复请求、disconnect 清空）、
  `src/hooks/useSessionManager.test.tsx`（按窗格会话翻页）。
- 全量 vitest：72 文件 / 697 通过 + 3 expected fail。
- Android 平板（adb + WebView CDP）实测：修复前时间线 1 行、117 条消息全是 assistant；
  修复后自动补页，用户提问行与折叠壳正常显示。

## 遗留

- 首屏窗口本身仍可能不含 user 锚点（Host 分页语义如此），依赖「内容不足一屏自动补页」+
  用户上滚触发 `loadMore`；超大单回合会话需要多补几页。
- `session.history` 的 `maxMessages = 60` 与 `loadOlderHistory` 的 60 是两处独立常量，
  后续如需调整请一起改。
