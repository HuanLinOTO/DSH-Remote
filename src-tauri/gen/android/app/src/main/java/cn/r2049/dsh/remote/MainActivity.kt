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
    // 转成 content view 的顶部 padding；旋转/折叠屏由 insets 重派发自动覆盖。
    // wry 的 WebView 由 Rust 侧延迟 setContentView，因此监听挂在其稳定的父容器
    // android.R.id.content 上（首次访问即完成 decor 安装），而不是 WebView 本身。
    val content = window.findViewById<ViewGroup>(android.R.id.content) ?: return
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.statusBars())
      if (view.paddingTop != bars.top) view.setPadding(0, bars.top, 0, 0)
      insets
    }
  }
}
