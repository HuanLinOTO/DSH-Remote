# 移动端 UX 三修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Android 平板/手机顶部状态栏不再遮挡应用内容；侧栏菜单提供"切换主机"回设备选择页；主机列表/登录表单全平台垂直居中。

**Architecture:** 三个互相独立的改动：① Android 原生层给 content view 打 statusBars inset 顶部 padding（不碰 JS/CSS，规避 Android WebView `env()` 恒 0 的问题）；② 侧栏菜单新增菜单项调用 `useDshStore.disconnect()`，由 `DshGate` 现有门控自动落回 HostListScreen；③ 连接页内层容器加 `my-auto` 实现居中且超高可滚动。

**Tech Stack:** Kotlin（Tauri Android gen 工程，androidx.core 已可用）、React + Tailwind（className 级改动）、i18n（react-i18next，`chat` 命名空间）。

**Spec:** `docs/plans/2026-09-06-mobile-statusbar-hostswitch-centering-design.md`

## Global Constraints

- 不修改任何 `/* THIS FILE IS AUTO-GENERATED. DO NOT MODIFY!! */` 文件（RustWebView/WryActivity/TauriActivity 等）。
- 工作区不是 git 仓库（无 `.git`）：所有"commit"步骤跳过，改为完成即汇报。
- 测试基线：全绿 = 692 passed | 3 expected fail（695 总数）；改出红测试先分辨环境问题。
- `edit` 工具 old_string 含中文可能匹配失败：含中文行用 ASCII 锚点定位。
- 布局红线：`toUiMessages`/VirtualRow 引用稳定性与本任务无关，但不要顺手重构任何 store/投影代码。

---

### Task 1: Android 状态栏 inset padding（MainActivity）

**Files:**
- Modify: `src-tauri/gen/android/app/src/main/java/cn/r2049/dsh/remote/MainActivity.kt`（整个文件仅 10 行，全量重写）

**Interfaces:**
- Consumes: androidx.core `ViewCompat`/`WindowInsetsCompat`（随 appcompat 传递依赖可用，无需改 build.gradle）。
- Produces: WebView 内容区从系统状态栏下沿开始；无 JS 侧接口变化。

- [ ] **Step 1: 重写 MainActivity.kt**

```kotlin
package cn.r2049.dsh.remote

import android.os.Bundle
import android.view.ViewGroup
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // enableEdgeToEdge 后 WebView 全出血，系统状态栏叠在页面顶部（ConnectionStatusBar）上。
    // Android WebView 的 env(safe-area-inset-*) 恒为 0，只能在原生层把 statusBars inset
    // 转成 content view 的顶部 padding。insets 变化（旋转/折叠屏）由系统自动重派发。
    val content = findViewById<ViewGroup>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.statusBars())
      view.setPadding(0, bars.top, 0, 0)
      insets
    }
  }
}
```

- [ ] **Step 2: 编译校验（可选，需 Android SDK）**

Run: `cd src-tauri/gen/android; ./gradlew.bat :app:compileDebugKotlin --console=plain -q`
Expected: BUILD SUCCESSFUL（若本机未配 SDK/NDK 则跳过，改为 Task 4 后真机 `pnpm tauri android dev` 验证）

### Task 2: 主机列表 / 登录表单垂直居中

**Files:**
- Modify: `src/features/connect/ConnectScreens.tsx:76`（LoginScreen 外层 form 容器）
- Modify: `src/features/connect/ConnectScreens.tsx:229`（HostListScreen 内层容器）

**Interfaces:**
- Produces: 无接口变化，纯 className。

- [ ] **Step 1: HostListScreen 内层加 my-auto**

`ConnectScreens.tsx` 第 229 行：

```tsx
// 原：
<div className="w-full max-w-md">
// 改为：
<div className="w-full max-w-md my-auto">
```

`my-auto` 在有富余空间时垂直居中（等效 items-center），内容超高时 auto margin 归零、
从顶部正常滚动——比给外层换 `items-center` 更安全（避免 flex 居中 + overflow 裁顶）。
外层 `items-start` 保留（被 my-auto 接管垂直分布）。

- [ ] **Step 2: LoginScreen 表单加 my-auto（防横屏小屏裁顶）**

`ConnectScreens.tsx` 第 77 行：

```tsx
// 原：
<form onSubmit={submit} className="w-full max-w-sm rounded-xl border border-border-200/60 bg-bg-000 p-6 shadow-float">
// 改：
<form onSubmit={submit} className="w-full max-w-sm my-auto rounded-xl border border-border-200/60 bg-bg-000 p-6 shadow-float">
```

### Task 3: 侧栏菜单"切换主机"入口 + i18n

**Files:**
- Modify: `src/features/chat/sidebar/SidebarFooter.tsx`（imports + 菜单项）
- Modify: `src/locales/zh-CN/chat.json:143`（sidebar 段）
- Modify: `src/locales/en/chat.json:143`（sidebar 段）

**Interfaces:**
- Consumes: `useDshStore`（`src/dsh/chat/sessionStore`，zustand store，`disconnect()` 已存在）
- Produces: 菜单项文案 key `chat:sidebar.switchHost`。

- [ ] **Step 1: 加 i18n key**

`src/locales/zh-CN/chat.json` 的 `sidebar` 段，`"settings": "设置"` 后加：

```json
    "switchHost": "切换主机",
```

`src/locales/en/chat.json` 同位置：

```json
    "switchHost": "Switch Host",
```

（`edit` 遇中文 old_string 失败时：zh 用 `"shareChat": "` 锚点行级处理，保持 CRLF。）

- [ ] **Step 2: SidebarFooter 加菜单项**

导入区（`../../../components/Icons`）加 `PlugIcon`；组件内（约 L305 "Menu Items" 块，
"设置"按钮之前）插入：

```tsx
            <button
              onClick={() => {
                closeMenu()
                void useDshStore.getState().disconnect()
              }}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[length:var(--fs-sm)] text-text-300 hover:text-text-100 hover:bg-bg-200/50 transition-colors text-left"
            >
              <PlugIcon size={14} />
              <span>{t('sidebar.switchHost')}</span>
            </button>
```

并在文件顶部加 `import { useDshStore } from '../../../dsh/chat/sessionStore'`。

- [ ] **Step 3: typecheck + 全量测试**

Run: `npm run typecheck && npm run test:run`
Expected: typecheck 0 错误；695 基线（692 passed | 3 expected fail）无新增红。

### Task 3: 真机冒烟（用户执行 / 如已连接设备可代跑）

- [ ] `pnpm tauri android dev`：确认 ① 状态栏下方才是 ConnectionStatusBar（旋转后仍正确）② 侧栏菜单"切换主机"点击后回主机列表 ③ 竖屏主机列表垂直居中、横屏不裁顶。

## Self-Review

- 覆盖：design doc 三问题 ↔ Task 1（遮挡）/ Task 2 前半（入口）/ Task 2 后半（居中）一一对应。
- 无占位符；接口只有 store 现有 `disconnect()`，无跨任务新符号。
- Kotlin 文件无 git 可提交，验证合并进 Step 2 / Task 3。
