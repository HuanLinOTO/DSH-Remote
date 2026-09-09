# 移动端/平板 UX 三修复：顶部状态栏遮挡、设备切换入口、主机列表居中

日期：2026-09-06 · 状态：已确认（用户选定：原生 padding / 侧栏菜单入口 / 全平台居中）

## 问题

1. **Android 平板/手机上看不到顶部状态栏**：`MainActivity` 调 `enableEdgeToEdge()` 后 WebView
   全出血，系统状态栏（时间/电量）直接叠在应用最顶部的 `ConnectionStatusBar` 上。CSS 侧
   `env(safe-area-inset-*)` 在 Android WebView 恒为 0，`index.css` 注释中提到的
   "MainActivity 注入真实值"的代码并不存在。
2. **无回到设备选择页的入口**：`DshGate` 首连成功后常驻应用外壳，`ConnectionStatusBar`
   仅在 offline 时给 retry/disconnect；正常连接期间没有任何 UI 能回到 HostListScreen。
3. **手机上主机列表贴顶**：`HostListScreen` 外层 `items-start`，竖屏下列表顶在系统栏下，
   与登录页（`items-center`）不一致。

## 方案

### 修复 1：Android 顶部 inset（原生 padding）

`src-tauri/gen/android/.../MainActivity.kt`：保留 `enableEdgeToEdge()`，注册
`ViewCompat.setOnApplyWindowInsetsListener`，把 `statusBars()` 的 top inset 作为
padding 打在 content view（`android.R.id.content`）上。insets 变化（旋转/折叠）自动重算；
页面刷新不受影响；不注入 JS/CSS，`--safe-area-inset-*` 维持 0，无双重叠加风险。
状态栏区域露出窗口底色（Material DayNight），与暗色主题几乎无差。

不改 generated 文件（RustWebView/WryActivity 等标记 DO NOT MODIFY）。

### 修复 2：侧栏菜单加"切换主机"

`src/features/chat/sidebar/SidebarFooter.tsx` 菜单（分享对话/设置同列表）新增一项：
icon `PlugIcon` + `t('chat:sidebar.switchHost')`，点击 `closeMenu()` 后
`void useDshStore.getState().disconnect()`。`disconnect()` 已清 `hostDescriptor`/
`selectedDevice`，`DshGate` 条件（`phase !== 'connected' && hostDescriptor === undefined`）
自动落回 HostListScreen。文案：zh `切换主机` / en `Switch Host`（`chat.json` 的
`sidebar` 段，SidebarFooter 使用 `['chat','common']` 命名空间）。

### 修复 3：主机列表全平台垂直居中

`ConnectScreens.tsx`：
- `HostListScreen` 内层容器加 `my-auto`（有富余空间时垂直居中，内容超高时 auto margin
  归零、从顶部正常滚动，避免 `items-center` + overflow 裁顶）。
- `LoginScreen` 表单同样加 `my-auto`，防小屏（横屏手机）下表单顶部被裁。

## 验证

- `npm run typecheck`、`npx vitest run`（现有 69 文件基线 695：692 passed | 3 expected fail）。
- Kotlin 无新增依赖（androidx.core 已随 appcompat 可用）；Android 真机验证：
  `pnpm tauri android dev`，检查状态栏不再压住 ConnectionStatusBar、旋转后正确。

## 不做

- 不改 ConnectionStatusBar（入口走侧栏菜单）。
- 不处理底部导航栏/键盘 inset（现状可用，未在本次范围内）。
