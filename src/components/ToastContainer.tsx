// ============================================
// ToastContainer — 通知 toast（dsh 版：仅保留通知，无更新提示）
// ============================================

import { useTranslation } from 'react-i18next'
import { notificationStore, useNotificationStore, type ToastItem } from '../store/notificationStore'
import { CloseIcon } from './Icons'

function Toast({ item, onDismiss, onClick }: { item: ToastItem; onDismiss: () => void; onClick: () => void }) {
  const { t } = useTranslation(['components', 'common'])
  const { title, body } = item.notification
  return (
    <div
      className="group relative flex items-center gap-2.5 p-3 glass border border-border-200/60 rounded-xl shadow-lg cursor-pointer hover:bg-bg-100/80 hover:border-border-300 transition-colors duration-150 pointer-events-auto"
      onClick={onClick}
      role="status"
    >
      <div className="min-w-0 flex-1">
        <div className="text-[length:var(--fs-sm)] font-medium text-text-100 truncate leading-tight">{title}</div>
        <div className="text-[length:var(--fs-xs)] text-text-300 truncate mt-0.5 leading-tight">{body}</div>
      </div>

      {/* Close — always visible */}
      <button
        className="shrink-0 flex items-center justify-center w-6 h-6 rounded-md text-text-400 hover:text-text-200 hover:bg-bg-200 transition-all duration-150 active:scale-90"
        onClick={e => {
          e.stopPropagation()
          onDismiss()
        }}
        aria-label={t('common:dismiss')}
      >
        <CloseIcon size={12} />
      </button>
    </div>
  )
}

export function ToastContainer() {
  const { t } = useTranslation(['components', 'common'])
  const { toasts } = useNotificationStore()

  if (toasts.length === 0) return null

  const handleClick = (item: ToastItem) => {
    const { id, sessionId, directory } = item.notification
    notificationStore.dismissToast(id)
    notificationStore.markRead(id)
    if (sessionId) {
      const dir = directory ? `?dir=${directory}` : ''
      window.location.assign(`#/session/${sessionId}${dir}`)
    }
  }

  return (
    <div className="toast-safe-top absolute right-3 left-3 md:left-auto md:w-80 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map(item => (
        <Toast
          key={item.notification.id}
          item={item}
          onDismiss={() => notificationStore.dismissToast(item.notification.id)}
          onClick={() => handleClick(item)}
        />
      ))}

      {/* Clear all */}
      {toasts.length >= 2 && (
        <div className="flex justify-end pointer-events-auto">
          <button
            className="text-[length:var(--fs-xs)] text-text-300 hover:text-text-100 px-2 py-1 rounded-md hover:bg-bg-200/60 transition-all duration-150 active:scale-95"
            onClick={() => notificationStore.dismissAllToasts()}
          >
            {t('toast.clearAll')}
          </button>
        </div>
      )}
    </div>
  )
}
