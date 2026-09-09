# AGENTS.md — DSH Remote 仓库指南

本文件面向在本仓库工作的编码 Agent。记录项目定位、生态边界、目录结构、线协议要点、验证命令与本仓库特有的实现约束。

## 项目定位

本仓库（DSH Remote，应用标识 `cn.r2049.dsh.remote`）是 **ds-harness-remote 生态的第三方桌面 / Android 客户端**：
界面层修改自 [OpenCodeUI](https://github.com/lehhair/OpenCodeUI)（Tauri 2 + React，GPL-3.0 衍生作品），
协议栈 vendor 自 [ds-harness-remote](https://github.com/liguobao/ds-harness-remote)（MIT，见 `src/dsh/VENDOR.md`），
通过 DSH Remote 协议连接远程 DeepSeek Harness 主机，复用原聊天 UI 渲染远程会话，并针对远程 / 移动端重做交互。
**本仓库不是 OpenCodeUI 的官方 fork，也不是 ds-harness-remote 的官方客户端**；署名与许可证见 `NOTICE` / `LICENSE`。

品牌已从 OpenCode 全面更名为 DSH Remote（localStorage 键、内部协议前缀 `dsh-*`、图标、
i18n 文案均已迁移，见 `src/utils/legacyStorageMigration.ts`）。保留不动：`@opencode-ai/sdk`
类型导入、GPL 署名、docker/openapi 遗留文件。

## 上游生态（重要）

| 仓库/服务 | 作用 |
| --- | --- |
| https://github.com/liguobao/ds-harness-remote | **原始仓库**（monorepo）：`packages/plugin`（Host 端，DSH 插件）、`packages/protocol`、`packages/crypto`、`packages/webrtc`、`packages/client-core`、`apps/android|vscode|browser`。`docs/protocol.md` 是线协议权威规范 |
| liguobao/dsh-desktop | 桌面端上游（本仓库的前身，OpenCodeUI 系） |
| 独立 Server 仓库（不在上述仓库内） | REST + Control WS + Relay + Signaling。官方部署 `https://dsh.r2049.cn`（serverVersion 0.1.0） |
| Host 运行时 | `pnpm dlx @deepseek-ai/dsh web`（官方 npm 包，不是本仓库代码） |

**仓库边界**：本仓库只做桌面 / Android Client。Server runtime、Host 插件、Remote Web、Admin 均不在本仓库实现；
协议问题先查上游 `docs/protocol.md`，代码冲突时以协议文档为准。

### 本仓库与上游的代码映射

- `src/dsh/vendor/protocol/` ← 上游 `packages/protocol/src`（控制帧编解码、schema、limits）
- `src/dsh/vendor/webrtc/` ← 上游 `packages/webrtc/src`（AdaptiveTransport、RTC data channel、chunking、relay）
- `src/dsh/vendor/client-core/` ← 上游 `packages/client-core`（RPC correlation、HarnessAlphaClient）
- 从上游同步时逐文件对照上述目录；vendor 内做过本仓库特有改动（如 `cryptoRandomId` 保持 v4）。

## 目录速查

```text
src/
  dsh/
    chat/
      sessionStore.ts      连接/会话状态机（bootstrap → login → host list → connect → chat）；
                            断线重连退避、AccountRequiredError 自动登出、visibilitychange 重连
      bridge.ts            Host 事件 → UI Message 同步（100ms 调度、流式 delta ~10fps 节流）
      event-reducer.ts     history/live 事件 → ChatItem（eventTime 用 event.time）
      toUiMessages.ts      ChatItem → UI Message 投影（WeakMap 引用稳定缓存，性能关键）
    connection/            AdaptiveTransport → SecureTransport(Noise IK) → RemoteClientCore
    server/                REST API + ServerSessionManager（token 刷新：过期前 30s 主动刷新）
    lib/tauri-websocket.ts 控制通道 WS 桥到 Rust（TauriBridgeWebSocket）
    vendor/                上游 packages 拷贝（见上）
  features/
    chat/                  ChatArea、chatPageModel（buildProcessTimeline 过程折叠时间线）
    connect/               DshGate（bootPhase/phase 门控）、LoginScreen、HostListScreen
    message/               MessageRenderer（ProcessCollapseBlock、processContentScope）
    settings/              设置面板（含"过程折叠"开关，themeStore.processCollapseEnabled）
  store/themeStore.ts      全局 UI 状态（localStorage 键前缀 dsh-*）
  components/DesktopTitlebar.tsx  ConnectionModeBadge（LAN/P2P/TURN/Relay + RTT）
src-tauri/src/app/commands/bridge.rs  Rust WS 桥（tokio-tungstenite）+ 应用层心跳 native pong
```

## 线协议要点（速查，权威以上游 docs/protocol.md 为准）

### 传输层

- **控制通道**：`wss://<server>/ws/v1/connect`，JSON 控制帧。hello（role/deviceId/accessToken/capabilities）
  → hello.ack（协商 capabilities、`heartbeatIntervalMs`、帧上限）→ connect.request → connect.accepted。
- **数据面优先级**：`lan > p2p > turn > relay`（AdaptiveTransport 自动尝试）。
  LAN=同机/同网 host 候选直连；P2P=公网打洞；TURN=中转；Relay=服务器 WebSocket 兜底。
  标题栏徽标显示的是 ICE 实际选中路径（`inspectSelectedPath`），连接建立时快照。
- **加密**：Noise IK over `secure.handshake` 控制帧；ciphertext 之后走 DataChannel 或 Relay frame。
- **帧上限**：Control 64 KiB；Relay 1 MiB；重组 secure message 4 MiB。

### 心跳 Ping/Pong（曾在此翻车，务必遵守）

- Server 每 25s 发应用层 `{"type":"ping","payload":{"nonce":...}}`；75s 未收到有效 pong 即 4009 断开。
- **pong 必须回显 nonce，且 `id` 必须是 ULID/UUID 形态**（规范要求 UUIDv7/ULID；服务器实际校验
  8-4-4-4-12 hex + 版本位，v4 可过）。自造 id（如 `pong-{ms}-{n}`）会被 `INVALID_MESSAGE`
  (4008) 立即断链 —— 2026-09-06 实测，连接每 25s 必死。
- WebView 后台冻结时 JS 定时器停摆 → JS pong 断供；Rust 侧 `native_pong_frame` 原生回 pong
  （`src-tauri/.../bridge.rs`，id 用 `format_v4_uuid` 生成合法 v4 形态）。

### 关闭代码 / 错误码（实测出现过的）

| 代码 | 含义 | 客户端应对 |
| --- | --- | --- |
| 4002 | token 过期 | 刷新凭证重连（见 plugin server-connection） |
| 4004 | 设备被吊销 | DEVICE_REVOKED，回登录 |
| 4008 | 消息校验失败（如 id 格式） | 修帧格式，重连 |
| 4009 | 心跳超时 | 检查 pong 供给（JS 节流/后台冻结） |

REST 侧 `AUTH_INVALID`/`DEVICE_REVOKED`/401 → `AccountRequiredError` → 清配置回登录页
（服务器可能单方面擦除设备注册，此时必须重新登录注册设备）。

### Token / 凭证

- 设备凭证在 `~/.dsh/remote/servers/<serverId>/client/`（device.json/device.key/server-credentials.json）。
- access token TTL ≈ 10min；`ServerSessionManager.authenticateOnce` 到期前 30s 自动刷新。
- Host 侧 `/auth/refresh` 会 403（仅 client 设备可刷新）。

## 本仓库特有的实现约束

1. **UI Message 投影必须保持引用稳定**：`toUiMessages.ts` 的 WeakMap 缓存、`chatPageModel.ts` 的
   `reuseProcessTimelineItems`、VirtualRow memo 链环环相扣；改消息结构时先想清楚对象标识。
2. **Host ≥0.1.2 的 session/list 行没有顶层 `title`**：标题在 `projections.values.title`
   （LLM 首轮对话后生成）。`liftSessionProjectionFields`（vendor alpha client，`RemoteApiProxy.sessionList`
   同样调用）负责提升到平铺行；`session/control` 的 title 投影经 `session/renamed` mux 帧 →
   `sessionStore.applySessionTitle` 实时更名；重命名 RPC 为 `session/rename`
   （compat.updateSession 的 title 分支）。fallback 标题取 id 去掉 `session-` 前缀后的尾段
   ——所有 Host id 都以 `session-` 开头，直接切头 6 位会全部显示 "Session sessio"。
3. **侧边栏按 Host 工作区分组**：SidePanel 的 `directoryRows` 把 `useDshStore.workspaces`
   （Host `workspace/follow`）作为分组第一来源（主机顺序优先，本地 saved-directories 去重后
   追加，仅单主机模式）；懒建会话（`useChatSession.sendMessageNow`）按当前路由目录匹配
   workspaceId，不再固定 `workspaces[0]`。**选中工作区 = 设置 `currentDirectory`**：扁平会话
   列表经 `scopedSessions` 按 `isSameDirectory` 过滤（置顶同样按目录收窄）；右侧面板
   WorkspacePicker 选择后也同步 `setCurrentDirectory`。
4. **流式同步要节流**：token-rate delta 风暴会卡死渲染（曾实测）。bridge.ts 的 scheduler
   （`createSyncScheduler`，100ms）与 streaming 节流不要绕过。
5. **过程折叠**（"完成后折叠中间过程"）：`buildProcessTimeline` 按用户消息分组挂壳；页首无锚点
   的懒加载续段收进合成壳 `HEAD_SHELL_KEY`。默认开启（themeStore），设置 → 对话 → 过程折叠可关。
   回合存活判定 = 消息级 live-work（running tool / streaming message / completed==null）
   **∪ session busy 保活**（`sessionRunningSteady`，`useStreamingSteady` 500ms 消抖）：
   最后一个有内容的回合在会话仍 busy 时保持 Working——覆盖工具循环间隙与重连后
   历史重折两类消息级空窗；消抖窗口同时消除"发送瞬间 busy 早于新 user 入列"的旧回合闪烁。
6. **DshGate 门控**：首次连接成功前显示 HostListScreen；之后断线/重连保持应用外壳，
   顶部 ConnectionStatusBar 展示状态（不要在断线时把用户踢回设备选择页）。
7. **WS 协议层 Ping/Pong**（RFC 6455）由 tokio-tungstenite 自动处理，与应用层 JSON ping/pong 是两回事。
8. 单实例锁：第二个实例直接退出；杀应用进程会级联杀掉它拉起的 vite dev server。

## 开发与验证

```bash
pnpm install
pnpm dev                      # vite (strictPort 5173；被占用会直接失败)
pnpm tauri dev                # 桌面应用（先起 vite 再起 Rust）
npm run typecheck             # tsc -b
npm run test:run              # vitest 全量（当前 72 文件 / 697 通过 + 3 expected fail）
npx vitest run <file>         # 单文件
cargo test --quiet native_pong   # Rust 侧（在 src-tauri/ 下）
npm run lint                  # eslint（存量 warning 在未触碰文件，忽略）
```

- 调试 CDP：`$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9223'` +
  `cargo run --no-default-features`，然后 `http://127.0.0.1:9223/json/list`；调试脚本放
  `%TEMP%\dsh-debug\`（放工作区内会拖死 vite watcher）。
- 应用日志：`%LOCALAPPDATA%\cn.r2049.dsh.remote\logs\DSH Remote.log`（UTC 时间戳，本地 UTC+8）。
  控制通道收发逐帧记录在案，排查断连先看这里。
- 出网走 mihomo 代理（127.0.0.1:7890）；git clone GitHub 需 `-c http.proxy=http://127.0.0.1:7890`。

## Agent 环境备注

- `edit` 工具的 old_string 含中文时可能匹配失败：改含中文的代码用 ASCII 锚点，或用 pwsh/run_node 行级重建（注意保持 CRLF）。
- 改 Rust 后务必 `cargo test`；bridge.rs 的测试模块曾因行级拼接错括号翻车。
- vite 对 `*.tmpdir` EBUSY 敏感（vite.config.ts 已加 watch ignore，勿删）。
- 测试基线：全绿 = 697 passed | 3 expected fail（700）。改出红测试先分辨是不是环境问题
  （Node 实验 localStorage 不枚举 key，`modelVisibilityStore.test.ts` 有专门处理）。

## 待观察 / 已知上游问题

- Host 端（@deepseek-ai/dsh web 0.1.2-rc.1）在服务器事件后可能不重拨（上游问题，不在本仓库修）。
- 服务器可能单方面擦除设备注册（2026-09-06 发生过）：表现为"该账号下没有注册的主机"，
  客户端已自动回登录页；重新登录即自愈。
- 主机列表不自动轮询 presence，需手动刷新。
