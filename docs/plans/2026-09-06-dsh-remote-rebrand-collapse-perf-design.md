# DSH Remote:品牌改名 + 过程折叠默认开启 + 渲染性能优化 — 设计

日期:2026-09-06
状态:已确认(用户选定:折叠默认开启;改名彻底全改含存储迁移)

## 背景

用户三点要求:
1. OpenCode 全部改成 DSH Remote。
2. 原版「完成后折叠中间过程」(用户称为「仅最新 Step」)没有生效。
3. 渲染极其卡顿,需要优化。

## 1. 渲染卡顿(根因与修复)

**根因 1**:bridge 每帧 `chatItemsToMessages` 全量重建所有 Message 对象 → 结构化复用
全部失效 → 流式期间整树重渲染。
**修复**:`toUiMessages.ts` 模块级 `WeakMap<ChatItem, Message>` 逐项投影缓存
(reducer 不可变更新,未变 item 引用稳定 → 缓存命中,流式只重渲染变化行)。

**根因 2(实测)**:长回复以 token 级频率产生 assistant/chunk delta,每个 delta 都
触发 store → bridge → messageStore → React 全链路(流式行的 Markdown 对不断变长的
全文重新解析)。CDP 实测:静置 1-2ms 响应;持续流式数十秒后主线程完全无响应
(`1+1` 求值超时)。
**修复**:bridge 增加 UI 推送节流(`createSyncScheduler`,~10fps,flush 读 store
最新 items;会话首帧与 running 翻转边界立即推送)。reducer 仍逐帧折叠保证数据完整。

**根因 3**:reducer `now(data)` 读 `data.time`,但 host 事件没有该字段(实测 1152 条
user/assistant/tool 事件均无),历史折叠全部回退 `Date.now()` → 所有 item createdAt
相同 → 回合时长恒为 0("已处理 0ms")。事件级 `NativeSessionEvent.time` 一直存在。
**修复**:reducer 全部改用 `eventTime(event, data)`(事件级 time → data.time → 本地时钟)。

## 2. 过程折叠(「仅最新 Step」)

事实:折叠管线(`buildProcessTimeline` / `ProcessCollapseBlock`,完成后中间过程收进
"Worked for Xm" 折叠块、最终回答留在外面)在 ChatArea 完整存在,但
`DEFAULT_PROCESS_COLLAPSE_ENABLED = false` 默认关闭 —— 这就是"没有实现"的原因。

**修复**:默认改为 `true`(设置里「过程折叠」开关保留可关)。

**不做**(YAGNI):为 dsh 合成 step-finish part。dsh 事件流没有 per-step token/cost
数据(每个 ChatItem 只有 createdAt),per-step 耗时恒为 0,信息行零值自动隐藏;
turnDuration 总耗时行已默认显示在最终回答下。「仅最新 Step」开关保持原语义
(对 opencode 后端 step-finish 生效),在 dsh 路径上惰性。

## 3. 品牌改名(彻底全改)

### A. 用户可见文案
`Header.tsx` document.title、`ErrorBoundary.tsx`、`AboutSettings.tsx`(上游署名保留
OpenCodeUI 链接,注明"上游")、`ChatPane.tsx` / `serverStore.ts` 诊断文案、
i18n zh-CN + en(settings / chat / components)、通知 tag。

### B. localStorage 键改名 + 启动一次性迁移
`layoutStore`(11 键)、`serverStore`(2)、`pinnedSessionsStore`(localStorage 全局键 +
serverStorage `srv:{id}:opencode-pinned-sessions` 模式)、`keybindingStore`、
`DirectoryContext`(2)、`serverWorkspaces`、`autoApproveStore`(2)、`notificationStore`(2)、
`notificationEventSettingsStore`、`multiServerStore`、`directoryUtils`(2)、`soundStore`(1)、
`SidePanel`(1)、`useBackClose`。
迁移策略:启动时 `migrateLegacyStorageKeys(old, new)` 列表逐对拷贝(新键不存在才拷),拷后删除旧键;失败静默。

### C. IndexedDB
`opencode-sounds` → `dsh-sounds`:soundStore 初始化时打开旧库只读拷贝全部记录到新库,成功后删除旧库;旧库不存在则跳过。

### D. 内部协议 / DOM 标识
- `#opencode-local-file:` → `#dsh-local-file:`(MarkdownRenderer + markdownHtmlRenderer)
- `opencode-html-*` postMessage 类型 / `data-opencode-*` 属性 / style id → `dsh-html-*`(htmlSandbox + MarkdownRenderer)
- `STYLE_ID_*`(style 元素 id)→ dsh-*
- `__opencodeuiBackClose` → `__dshuiBackClose`
- `__opencode_android` → `__dsh_android`(读取处保留旧名回退,兼容可能存在的外部旧包装器)

### E. 文件 / 资源
- `toOpenCodeMessages.ts`(+测试)→ `toUiMessages.ts`,内部 `*ToOpenCode*` 函数改名
- `public/opencode.svg` → `dsh-remote.svg`(index.html / manifest.json / useNotification 引用同步;图标美术替换另列任务)
- `src-router/src/router.html` 标题
- 注释里的品牌词同步改写(历史沿革类注释除外)

### F. 保留(不可改 / 不应改)
- `@opencode-ai/sdk` type-only imports:第三方包名,构建期擦除,物理上不可改名。
- `docker/`、`openapi*.json`、`package-lock`:上游遗留部署物 / API 参考文档。
- README/CHANGELOG 中 GPL 上游署名与历史记录。
- 指 opencode 二进制/配置/环境变量本身的字符串(opencode serve、opencode.json、OPENCODE_SERVER_PASSWORD)——它们描述的是真实第三方产物,不可谎称。

## 验证结果(2026-09-06)

1. `rg -i opencode src/` 剩余项仅 F 类(SDK type imports、二进制/配置名、上游署名、迁移表自身、`__opencode_android` 回退)。
2. `pnpm typecheck` ✓;`pnpm vitest run` 69 文件 / 675 通过 / 3 预期失败 ✓。
3. CDP 实测:窗口标题与侧栏品牌 "DSH Remote" ✓;app 驱动的已完成回合出现折叠壳
   ("已处理 …" 标头,可展开/收起,壳内消息默认收起)✓;重会话(848f94aa)~2s 加载、
   静置响应 1-9ms ✓。
4. 未尽事项:持续流式下的节流效果需在 host 重新注册后由用户日常使用确认(验证期间
   dsh 服务器账号下主机列表为空,属 host 侧注册状态,与本仓库改动无关)。

---

## 附:晚间追查「主机不在线」(同日追加)

用户报告 app 显示主机不在线。逐层排查定位到三个叠加问题:

1. **服务器侧**:dsh.r2049.cn 当天丢失了设备注册数据(上午还在的 W11/LAPTOP 注册
   到晚间全部消失)。host 侧(官方 dsh 包)自行重新注册自愈(22:13:46,新设备身份);
   服务器当前 presence online:true(直连 API 验证)。
2. **app 控制通道被 4009 杀死且不重连**:app 日志 `ws closed by server code=4009
   heartbeat timeout`。根因:服务器应用层心跳(JSON ping)依赖 WebView 里的 JS 回
   pong,切后台 WebView 冻结 → pong 断供;冻结同样把退避重连定时器推向分钟级。
   修复:
   - `src-tauri/src/app/commands/bridge.rs`:`native_pong_frame` 在 Rust 原生层直接
     回应应用层 ping(与 WS 协议层 Ping/Pong 处理对齐),心跳不再依赖 WebView 存活;
   - `sessionStore.ts`:visibilitychange 回前台时若处于 offline/reconnecting 立即
     补一次重连(绕过被冻结的退避定时器)。
3. **app 设备凭据被服务器拒绝**:同一服务器数据事故清掉了 app 的客户端设备注册,
   refresh 被拒后 app 停在空主机列表("该账号下还没有注册的主机"),用户无从下手。
   修复:`session-manager.authenticateOnce` 把 refresh 被拒(AUTH_INVALID/401/
   DEVICE_REVOKED)转成 `AccountRequiredError`;`refreshDevices`/`connectDevice`
   收到后清配置回登录页,重连循环停止。用户重新登录即恢复(重新注册设备)。

验证:cargo test(native_pong ×2)✓;typecheck + 全量 vitest 676 通过 ✓;CDP 实测
死凭据自动踢回登录页 ✓。
