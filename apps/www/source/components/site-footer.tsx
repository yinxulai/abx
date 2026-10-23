import { useTranslation } from 'react-i18next'
import { AirlockMark } from './airlock-mark'

export const SiteFooter = () => {
  const { t } = useTranslation()

  return (
    <footer className="relative border-t border-line">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-6 py-10 text-sm text-ink-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-center gap-2 text-ink-3">
          <AirlockMark className="size-5" />
          abx · airlock box
        </p>
        <p>{t('footer.line', '给 AI coding agent 的隔离舱。第一版只做 macOS。')}</p>
      </div>
    </footer>
  )
}
