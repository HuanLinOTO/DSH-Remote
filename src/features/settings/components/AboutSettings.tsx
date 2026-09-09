import { useTranslation } from 'react-i18next'
import { SettingsSection } from './SettingsUI'
import { APP_VERSION } from '../../../env'
import { openExternalUrl } from '../../../utils/openExternal'

export function AboutSettings() {
  const { t } = useTranslation('settings')
  return (
    <div className="flex flex-col gap-4">
      <SettingsSection title={t('about.title')}>
        <div className="flex flex-col gap-2 text-sm text-text-200">
          <div className="flex items-center justify-between">
            <span className="text-text-400">{t('about.version')}</span>
            <span>v{APP_VERSION}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-text-400">{t('about.upstream')}</span>
            <button
              type="button"
              className="text-blue-400 hover:underline"
              onClick={() => void openExternalUrl('https://github.com/lehhair/OpenCodeUI')}
            >
              OpenCodeUI（上游）
            </button>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-text-400">{t('about.protocol')}</span>
            <button
              type="button"
              className="text-blue-400 hover:underline"
              onClick={() => void openExternalUrl('https://github.com/liguobao/ds-harness-remote')}
            >
              ds-harness-remote
            </button>
          </div>
          <p className="text-xs text-text-400">{t('about.license')}</p>
        </div>
      </SettingsSection>
    </div>
  )
}
