import { useEffect, useState } from 'react'

/**
 * 会话 busy 消抖：streaming 持续为 true 超过 steadyMs 才返回 true；翻 false 立即复位。
 *
 * 用途：过程折叠的「最后一个有内容回合保持 Working」保活信号。直接用原始
 * streaming 会在发送瞬间（busy 早于新 user 入列）让旧回合闪回 Working；
 * 消抖窗口内新 user 已入列，旧回合不再是最后一个回合，闪烁消失。而工具循环
 * 间隙（tool/result 已到、下一条 assistant 未到）和重连后历史重折（消息瞬时
 * 全 completed）都远长于该窗口，保活始终生效。
 */
export function useStreamingSteady(isStreaming: boolean, steadyMs: number): boolean {
  const [steady, setSteady] = useState(false)

  useEffect(() => {
    if (!isStreaming) {
      setSteady(false)
      return
    }
    const timer = window.setTimeout(() => setSteady(true), steadyMs)
    return () => window.clearTimeout(timer)
  }, [isStreaming, steadyMs])

  return steady
}
