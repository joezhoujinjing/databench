import i18next from '@/i18n/index.js'
import { localeDictionaries } from './translations.js'

let registered = false

export function registerEvaluationTranslations(): void {
  if (registered) return
  i18next.addResourceBundle('en', 'translation', { evaluations: localeDictionaries.en }, true, true)
  i18next.addResourceBundle('zh', 'translation', { evaluations: localeDictionaries.zh }, true, true)
  registered = true
}
