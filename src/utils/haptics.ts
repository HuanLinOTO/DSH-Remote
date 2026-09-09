// Best-effort haptic tap: Android native bridge first, W3C Vibration API fallback.

export function hapticTap(ms = 8): void {
  try {
    // 兼容旧 OpenCodeUI Android 包装器：优先 DSH 桥名，回退旧名
    const bridges = window as unknown as {
      __dsh_android?: { vibrate?: (n: number) => void }
      __opencode_android?: { vibrate?: (n: number) => void }
    }
    const b = (bridges.__dsh_android ?? bridges.__opencode_android)?.vibrate
    if (b) return b(ms)
    navigator.vibrate?.(ms)
  } catch { /* ignore */ }
}
