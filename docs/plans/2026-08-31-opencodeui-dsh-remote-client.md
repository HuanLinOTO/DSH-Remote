# 将 OpenCodeUI 改造为 ds-harness-remote 的客户端（Web/PWA，Android 优先）

日期：2026-08-31
工作区：`D:\Projects\DSH-Remote4Android`（当前为空目录）

## 1. 目标与成功标准

把 [OpenCodeUI](https://github.com/lehhair/OpenCodeUI)（React 19 + Vite 7 + Tailwind v4 的 OpenCode Web 前端）改造为 [ds-harness-remote](https://github.com/liguobao/ds-harness-remote) 的 Remote Client：用户登录 DSH Remote Server 账号 → 选择在线 Host → 选择 Workspace → 用 OpenCodeUI 的聊天界面远程操作 Harness（发消息/图片、看流式回复与工具调用、应答审批与提问、取消、切模型）。

成功标准：

1. **登录**：填服务器地址（默认 `https://dsh.r2049.cn`）+ 账号密码登录，生成本机 X25519 设备身份并完成 `POST /api/v1/devices/register`，刷新令牌可自动续期。
2. **主机列表**：展示同账号下 Host（在线状态、版本），点选 Host 后按协议完成 `connect.request → connect.incoming → Noise IK 握手`，状态展示 auth→transport→secure→loading→ready。
3. **会话**：`workspace.list` 选工作区 → `session.list` 会话侧栏 → `session.history` 还原历史 + mux 实时流渲染增量（text/reasoning 流式、工具卡片、审批、提问）。
4. **交互**：发送文本与图片（>2MiB 走 transfer 分块）、`session.cancel` 停止、`session.models/selectModel` 切模型、`harness.api.respond` 应答审批/提问。
5. **协议合规**：只用 `harness.api.*`（rc.2）/ `harness.remote.*`（alpha）官方隧道；复用上游 `@dsh-remote/*` 包；协议包测试与事件 reducer 测试通过；`npm run validate` 通过。
6. **移动端**：PWA 在 Android Chrome 可安装使用（OpenCodeUI 已有移动适配）；桌面浏览器可用。

## 2. 两个项目的现状（探索结论）

### OpenCodeUI（被改造对象，工作区将 clone 其源码）

- React 19 + Vite 7 + Tailwind v4 + zustand + vitest；GPL-3.0-only。
- 数据层 `src/api/*` 全部指向 OpenCode 后端（REST + SSE：`session/message/permission/file/pty/vcs/mcp/lsp/skill...`），`@opencode-ai/sdk` 直连依赖。
- 连接层 `src/api/events.ts`（1050 行）：每 server 一条 SSE，含心跳/重连/代次/delta 合并，向 `EventCallbacks` 订阅者广播。
- 状态层 `src/store/*`：`serverStore`/`multiServerStore`（多服务器，会话 key 为 `serverId::sessionId` 复合 key）、`messageStore`（`Message{info, parts[]}`，parts 为 text/reasoning/tool/file/step-* 等强类型）、`layoutStore`、`themeStore` 等。
- UI 层：聊天（`features/chat`，含 `InputBox`、`ModelSelector`、`PermissionDialog`/`InlinePermission`、`QuestionDialog`/`InlineQuestion`）、消息渲染（`features/message`，Markdown/Shiki/工具注册表）、会话侧栏、设置面板、移动端三栏 pager、PWA（manifest + notification-sw）、Tauri 2 桌面壳。
- 与 DSH 协议无关、必须拆除的能力：内置终端（xterm/PTY）、文件浏览/Diff 右栏、worktree、动态端口路由、Share、OpenCode config 编辑器。

### ds-harness-remote（协议与参考实现）

- pnpm monorepo，MIT；核心可复用包（均为纯 TS/浏览器兼容）：
  - `packages/protocol`：v1 envelope/schema/编解码（zod）、`SecureMessageCodec`（DSHF 分片：48KiB 分片 / 4MiB 上限）、限速常量。
  - `packages/crypto`：`NoiseIkSession`（clatterjs Noise_IK_25519_ChaChaPoly_SHA256 + @noble/*）、`createNoisePrologue`、`generateKeyPair`。
  - `packages/webrtc`：`AdaptiveTransport`（Control WSS + hello/connect.request/signal/relay，LAN→P2P→TURN→Relay，含 `browserRtcFactory()`）。
  - `packages/client-core`：`RemoteClientCore`（RPC 关联/超时/事件分发）、`probeRemoteHostFeatures`、`HarnessAlphaClient`（alpha Typert 端）。
- 业务隧道（rc.2）：`harness.api.call`（固定 allowlist 的原生 ApiProxy 方法：`session.list/create/history/prompt/cancel/models/selectModel`、`workspace.*`、`host.describe/listDirectory`、`commands.execute`…）、`harness.api.respond`（答审批/提问，rpcId 必须来自 mux 帧）、`harness.api.stream.open/close`（mux/host 流，`harness.api.frame` 事件）、`harness.api.transfer.*`（>2MiB envelope 分块，512KiB/块）。
- 参考实现：`apps/android`（Expo + TS）——`services/api.ts`（REST 全集）、`server-session-manager.ts`（登录/注册/刷新）、`secure-transport.ts`（Noise 包装）、`connection.ts`（连接编排 + feature 探测）、`api-proxy.ts`（业务客户端）、`state/event-reducer.ts`（native 事件 → ChatItem）、`state/store.ts`（zustand 会话编排）。
- 测试支持：`examples/mock-host`（Node 模拟 Host，需连真实 relay server）+ `fixtures/protocol` conformance 向量。

关键结论：**协议栈四包 + Android 客户端的 service/reducer 层可以几乎原样移植到 Web；OpenCodeUI 的"服务器"概念 ≙ DSH 的 Host，改造的主战场是数据层替换 + 少量 UI 适配。**

## 3. 目标架构

```
OpenCodeUI UI（保留：ChatArea / InputBox / Sidebar / ModelSelector /
               PermissionDialog / QuestionDialog / 设置 / 主题 / 移动布局）
        │  Message{info, parts[]}（渲染边界）
┌───────▼────────────────────────────────────────────┐
│ dsh 适配层（新增 src/dsh/）                          │
│  chatItemsToMessages()  ChatItem → Message/Part 适配 │
│  event-reducer.ts（移植 Android，纯函数）             │
│  sessionStore（会话/历史/流式/审批/提问，zustand）     │
│  RemoteApiProxy(rc.2) ── HarnessAlphaClient(alpha)   │
│  RemoteClientCore + SecureTransport(Noise IK)        │
│  AdaptiveTransport(Control WSS + WebRTC/Relay)       │
│  RemoteServerApi（REST：login/register/refresh/      │
│    devices/presence/TURN）+ 凭据持久化(localStorage)  │
└───────┬────────────────────────────────────────────┘
        │ HTTPS + WSS
DSH Remote Server（dsh.r2049.cn）──relay──▶ Host 插件（真实 Harness）
```

会话标识沿用 OpenCodeUI 的 `hostId::sessionId` 复合 key（serverId 即 hostDeviceId），为后续多 Host 并连留缝；v1 同一时刻只保持一条活跃 Host 连接（与官方 Remote Web 一致）。

## 4. 关键设计决策

- **D1 复用而非重写协议栈**：把 ds-harness-remote 的 `packages/{protocol,crypto,webrtc,client-core}` 源码 vendor 进 `src/dsh/vendor/`（Vite 直接编译 TS 源码，不引入 pnpm workspace），`src/dsh/VENDOR.md` 记录来源仓库与 commit。新增依赖：`zod`、`@noble/ciphers`、`@noble/curves`、`@noble/hashes`、`@lukeburns/clatterjs`（全部浏览器兼容；上游为 MIT，保留版权声明）。理由：协议"禁止自行实现 Noise 状态机"，且这四包自带测试。
- **D2 以 Android 客户端为业务蓝本**：`RemoteServerApi`/`ServerSessionManager`/`SecureTransport`/连接编排/`RemoteApiProxy`/`event-reducer` 逐文件移植（去除 Expo 依赖：SecureStore→localStorage、Netinfo→navigator.onLine、expo-crypto→WebCrypto）。
- **D3 消息模型：ChatItem 为源、渲染处适配**：移植 Android `event-reducer.ts`（含乐观消息 `requestRpcId` 对账、`stream:turn:step` 流式行、tool view 卡片文本化、approval/question 生命周期）。新增纯函数 `chatItemsToMessages(items): Message[]`，把 ChatItem 映射为 OpenCodeUI 的 `Message/Part`（user→TextPart+FilePart 占位；assistant→ReasoningPart+TextPart；tool→ToolPart{state, output=resultDetail.text, metadata={card}}；approval/question→新 UI 组件直读 ChatItem）。`messageStore` 结构不动，数据源换成 reducer。
- **D4 rc.2 与 alpha 双代支持**：连接后 `probeRemoteHostFeatures(core, host.clientVersion)`；`remoteGateway` → `HarnessAlphaClient`，否则 `apiProxy` → `RemoteApiProxy`；两者在 store 中表现为同一个 `HarnessClient` 接口（同 Android `RemoteHarnessClient`）。
- **D5 v1 单活跃 Host 连接**：Sidebar 顶部为 Host 选择器（替代 ProjectSelector 的服务器维度）；切换 Host = 关闭旧连接（`close(notifyRemote=false)` 语义）再连接。会话列表/历史按 `(hostId, sessionId)` 缓存。
- **D6 CORS/同源策略**：浏览器端 REST/WS 与 `dsh.r2049.cn` 跨源可能被拒（官方 Remote Web 为同源部署）。对策三件套：① Vite dev proxy 把 `/api`、`/ws` 代理到所配 Server；② 提供自托管反代部署（复用 OpenCodeUI 的 docker/Caddy：`/api/*`、`/ws/*` → `https://dsh.r2049.cn`，静态文件本地）；③ Tauri 构建（保留）用 plugin-http 天然绕过 CORS。`RemoteServerApi` 支持任意自定义 server URL，同源部署时走相对路径。
- **D7 凭据与密钥存储**：设备 X25519 密钥对 + device token pair 存 `localStorage`（`dsh-remote:<serverUrl>:<deviceId>` 命名空间，沿用 OpenCodeUI per-server storage 工具思路）。账号密码 token 只在注册瞬间使用、不落盘（同 Android）。刷新按 `ServerSessionManager.authenticateOnce` 逻辑（剩 30s 内先 refresh，失败抛 `AccountRequiredError` 回登录页）。日志严禁输出 token/key/prompt。
- **D8 砍掉/隐藏清单**（v1）：终端/PTY（`api/pty*`、xterm 依赖、BottomPanel 终端 tab）、文件浏览/Diff/预览（`api/file`、FileExplorer、RightPanel 文件类 tab → 换成 Host 信息面板）、worktree/vcs/mcp/lsp/skill/agent/todo API 及入口、`@opencode-ai/sdk`、OpenCode config 编辑器、Share/端口路由、`docker/` 的 backend/gateway 服务（保留并改造成"静态前端+反代"单服务）。CommandPalette/快捷键同步裁剪。
- **D9 命名与合规**：项目更名 `DSH Remote UI`（package name `dsh-remote-ui`），PWA manifest/标题/favicon 更新；**继承 GPL-3.0**（OpenCodeUI 衍生作品），README 注明上游与协议来源。

## 5. 实施分解（按子系统）

### 5.1 仓库初始化
- `git clone https://github.com/lehhair/OpenCodeUI .`（保留历史以利溯源与 GPL 署名），建分支 `dsh-remote`。
- 元数据：`package.json` name/version/description、`index.html`（title/apple-touch）、`public/manifest.json`、`public/opencode.svg`→新图标（可先用文字占位）、`README.md` 重写。
- `src/locales/{zh-CN,en}/*` 增补 `dsh` 命名空间文案（登录/主机/连接状态/权限/问题等），复用 Android `locales/zh-CN.ts` 的措辞。

### 5.2 Vendor 协议栈（`src/dsh/vendor/`）
- 拷贝四包 `src/`（`protocol/index.ts`、`crypto/{index,noise}.ts`、`webrtc/src/*`、`client-core/*.ts`），保持相对导入（`./remote-gateway.js` 后缀导入 Vite 可解析）。
- 拷贝对应 vitest 测试到同目录 `__tests__/`（改 import 路径），`packages/protocol/tests/conformance-fixtures.test.ts` + `fixtures/` 一并带入。
- tsconfig/eslint 增量放行 vendor 目录（如需要的规则差异）；Vite manualChunks 加 `vendor-dsh`。

### 5.3 Server REST 与凭据（`src/dsh/server/`）
- `api.ts`：移植 Android `RemoteServerApi`（`/health`、`/api/v1/auth/login`、`/devices/register`、`/auth/refresh`、`/devices`、`/devices/{id}`、`/devices/{id}/presence`、`/turn/credentials`、`/auth/oauth/*/status`、`DELETE /devices/self`），错误码映射保留；fetch 超时 10s。
- `identity.ts`：`generateKeyPair()`（@noble）+ deviceId（UUIDv4）+ 设备名（`navigator.userAgent` 摘要 / `platform: web`）。
- `credentials.ts`：localStorage 读写 + 原子替换 token pair。
- `session-manager.ts`：移植 `ServerSessionManager`（password 登录→注册→持久化；OAuth 状态探测接口保留，v1 仅密码登录；注册指引链接到 `https://dsh.r2049.cn/app/register`）。

### 5.4 传输与连接（`src/dsh/connection/`）
- `secure-transport.ts`：逐行移植 Android（initiator、prologue=`createNoisePrologue(connectionId, hostId, clientId)`、10s 握手超时、SecureMessageCodec 编解码）。
- `connection.ts`：移植 `AndroidRemoteConnection`：`AdaptiveTransport(websocketUrl(baseUrl), {role:'client', deviceId, accessToken, targetDeviceId, preferredTransports:['lan','p2p','turn','relay'], fetchIceServers})` → `SecureTransport` → `RemoteClientCore(35s)` → feature 探测 → `RemoteApiProxy`/`HarnessAlphaClient` → `openMuxStream`；保留 WebRTC fallback 后换 relay-only 新建连接的处理。暴露 `ConnectionPhase/Stage`（disconnected/connecting/reconnecting/offline + authenticating/transport/secure/loading/ready）供 UI。
- 断线重连：`core.onClose` → phase=reconnecting → 指数退避重建 → 重开 mux → 对当前打开会话重拉 `session.list` + `session.history`（协议 §21：无 replay buffer，重走 history baseline）。`lastSeq` 按 host 持久化，仅用于日志/诊断。
- 心跳/后台：沿用 OpenCodeUI events.ts 的可见性策略（document.hidden 时放宽重连节奏）。

### 5.5 Harness 业务客户端（`src/dsh/harness/`）
- `api-proxy.ts`：移植 Android `RemoteApiProxy`（call/transferred/respond/respondApproval/respondQuestion/openMuxStream + session/workspace/host/model 方法族），直调阈值 2MiB、chunk 512KiB、上限 288MiB。
- `client.ts`：`type HarnessClient = RemoteApiProxy | HarnessAlphaClient` 统一门面（`sessionList/sessionCreate/sessionHistory/sessionPrompt/sessionCancel/sessionModels/sessionSelectModel/workspaceList/workspaceCreate/hostDescribe/hostListDirectory/respondApproval/respondQuestion`）。
- 图片发送：输入附件（png/jpeg/webp/gif）→ canvas 压缩（限单图与总量，参考 Android `ImageAttachmentLimits`）→ base64 → `session.prompt` content `image` part（>2MiB 自动走 transfer 路径，由 api-proxy 封装）。

### 5.6 聊天状态与渲染（`src/dsh/chat/` + store 改造）
- `event-reducer.ts`：移植 Android（`foldHistory` / `applyMuxFrame` / `applyMuxFrameToMessages`），连同其测试。
- `sessionStore.ts`（zustand）：`sessionsByHost`（`session.list` 的 RemoteSession → 侧栏数据）、`chatItems: Record<sessionKey, ChatItem[]>`、`historiesLoading`、`streaming`（由 `session.running` + 流式行推导）、发送/取消/重试动作、`lastSeq`/断线标记。
- `toOpenCodeMessages.ts`：ChatItem→`Message{info,parts}` 适配（D3），生成稳定 part id（`{chatItemId}:{index}`）以配合现有 key/动画/虚拟滚动。
- `messageStore`/`useChatSession.ts`/`useGlobalEvents`：替换数据源——`useGlobalEvents` 改为订阅 `AdaptiveTransport` 的 mux 帧（保留其"单一连接、按会话分发、重连广播"的消费接口形态，实现从 SSE 换成 mux frame）；`useChatSession` 的 send/cancel/model/permission 调用改指 `HarnessClient`。分屏 pane 逻辑保留（同一 Host 内多会话，mux focus 省略=全量转发，无需 stream 切换）。
- 权限/提问：`InlinePermission`/`PermissionDialog` 改读 `ApprovalActivity`（toolName/reason/outcome；允许=allow_once）；`InlineQuestion`/`QuestionDialog` 改读 `QuestionActivity`（支持 multiSelect/custom answer/plan-review intent）；答复走 `respondApproval/respondQuestion(frameRpcId, …)`，收到 `approval/resolved`/`question/resolved` 后更新状态；`PERMISSION_NOT_PENDING` 静默降级。

### 5.4 补充：连接 UI
- 新 `features/connect/`：`LoginScreen`（server URL+邮箱+密码，错误码→文案；注册引导外链）、`HostListScreen`（REST devices 列表 + presence 轮询 30s + 在线标记 + 版本 + 连接按钮）、`WorkspacePicker`（`workspace.list` + `host.listDirectory` 浏览新建 `workspace.create`）、连接状态条（phase/stage/transport/rtt，来自 `AdaptiveTransport` stats）。
- 路由：沿用 hash 路由。新增未登录态 gate（无有效凭据 → LoginScreen）；`#/hosts`、`#/{hostId}::…`。

### 5.6 构建/部署
- `vite.config.ts`：dev proxy `/api`、`/ws`（ws:true）→ `VITE_DSH_SERVER`（默认 `https://dsh.r2049.cn`，同源部署时为空）；移除 `/api→opencode` 代理。
- `docker/`：精简为 单 Caddy（静态 + `/api`、`/ws` 反代到 dsh.r2049.cn，SSE/WS 透传 flush off）；`docker-compose.standalone.yml` 保留改造。
- 依赖增删：+ zod/@noble/*/clatterjs；- `@opencode-ai/sdk`、`@xterm/*`；其余（shiki/tailwind/i18n/tauri…）不动。

### 5.7 测试与验收
- 单测：vendor 包自带测试（协议 conformance fixtures）、`event-reducer` 移植测试、`chatItemsToMessages` 适配测试、`RemoteServerApi`（fetch mock，移植 Android `api.test.ts`）、`ServerSessionManager`、Token 刷新竞态。
- 组件测试：登录/主机列表/权限问答组件（testing-library，沿用现有配置）。
- 手动 E2E 矩阵：
  1. `npm run dev` + VITE proxy → `dsh.r2049.cn` 真实账号登录 → 主机列表。
  2. 跑 `examples/mock-host`（同账号注册的 Host device）→ 连接 → 会话列表 → 历史还原 → 发消息 → mock 流式回包 → 审批允许/拒绝 → 提问作答。
  3. 真实 Harness Host（dsh-v0.1.1-rc.2）冒烟：新建会话、图片 prompt、断网重连、Host 离线提示。
- `npm run validate`（typecheck+lint+test+build）绿。

## 6. 里程碑

- **M1 地基**：clone/改名/依赖增删；vendor 四包并使自带测试通过；`src/dsh/server`（REST+凭据）+ 登录页可用（能注册设备、拉到 Host 列表）。验收：登录后控制台可见 devices JSON。
- **M2 连接**：AdaptiveTransport+SecureTransport+RemoteClientCore 打通 relay 通道；连接状态 UI；`host.describe` 成功。验收：对 mock-host 完成握手并读到能力集。
- **M3 会话只读链路**：workspace/session.list、session.history + reducer → ChatItem → 适配成 Message 渲染；侧栏会话切换。验收：mock-host 会话历史完整渲染、流式增量可见。
- **M4 交互闭环**：发送/乐观消息/取消/模型选择/图片 prompt（transfer 路径）/审批与问答应答/断线重连与历史重拉。验收：§5.7 矩阵 2 全过。
- **M5 收尾**：拆除清单执行完（构建无死代码）、多语言文案、PWA manifest、docker 同源反代、`npm run validate`、真机 Android Chrome PWA 验证。alpha Host（HarnessAlphaClient）兼容联调。

## 7. 边界情况与失败模式

- **Host 离线/连接失败**：host 列表标灰；连接失败显示协议错误码（`HOST_OFFLINE`/`CONNECTION_FAILED`/`SECURE_CHANNEL_FAILED`）。
- **连接被替换**（同 clientDeviceId 新连接）：旧连接 `TRANSPORT_CLOSED` → 自动重连可能形成踢踢循环；识别 `CONNECTION_REPLACED` 后停止自动重试并提示（同官方行为：另一窗口接管）。
- **RPC 超时（35s）**：mutation 不盲重发；发送失败提供手动"重试"，UI 乐观行标记失败可删除。
- **identity 变化**：`PEER_IDENTITY_MISMATCH` → 清除该 host 的 pinned key 并要求用户显式确认后重连（协议 §11 pinned 语义）。
- **历史还原**：`session.history` 分页（`beforeSeq` + `maxMessages=60`，向上滚动加载更多）；mux 帧与 history 不做 seq 对账（上游隧道无 replay），以"重连即全量重拉当前会话"为一致性兜底。
- **token 过期/被吊销**：`AUTH_REQUIRED/AUTH_INVALID/DEVICE_REVOKED` → 清凭据回登录页；refresh 轮换失败同。
- **后台标签页**：visibilitychange 时保持 WS（浏览器可能节流 timer）；回前台立即心跳检查 + 状态校正。
- **大消息**：>4MiB 的 mux 帧由 SecureMessageCodec 分片重组；>2MiB 的 ApiProxy envelope 走 transfer（api-proxy 已封装）；超 288MiB 直接拒绝。
- **WebRTC 不可用**：AdaptiveTransport 自动降级 relay；fallback 后按 Android 模式换 relay-only 新 connectionId 重建。

## 8. 假设与风险

- **假设**：注册入口用官方 Remote Web（`/app/register`，有邀请制要求）；本客户端只做密码登录 + 后续可加 OAuth 跳转（GitHub OAuth 需要 redirect URI 备案，v1 不做）。
- **风险：跨源被拒**（REST CORS 或 WS Origin 校验）→ 已由 D6 同源反代兜底；Tauri 构建不受影响。
- **风险：mock-host 与真实 relay 的账号邀请制**可能阻碍自动化 E2E → 先行用手动矩阵；若拿到自托管 server 再补 CI。
- **风险：Harness 原生事件演进**（`user/message`、`assistant/chunk`、tool view 等 wire 形状）——reducer 按 Android 0.4.2 的防御式解析移植，未知事件静默忽略。
- **范围风险**：OpenCodeUI 面积大，拆除以"API 模块删除 + UI 条目隐藏"最小 diff 进行，避免大规模重构布局层。

## 9. 明确不做（v1）

File Viewer（`fileviewer.read.v1`）、`commands.list` 面板、agent preset 切换、远端设置/凭据平面（`settings.*`/`credentials.*`）、subagent 视图、多 Host 并连、Tauri Android 打包（PWA 已覆盖移动场景，打包放 M6+）。
