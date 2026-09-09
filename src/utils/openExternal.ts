// 在系统浏览器中打开外部链接（Tauri 走 opener 插件，Web 回退 window.open）。

import { isTauri } from './tauri'

export async function openExternalUrl(url: string): Promise<void> {
  if (isTauri()) {
    await import('@tauri-apps/plugin-opener')
      .then(mod => mod.openUrl(url))
      .catch(() => window.open(url, '_blank', 'noopener,noreferrer'))
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}
