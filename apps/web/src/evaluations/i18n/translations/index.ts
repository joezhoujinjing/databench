import * as benchmarks from './benchmarks.js'
import * as charts from './charts.js'
import * as common from './common.js'
import * as compare from './compare.js'
import * as dashboard from './dashboard.js'
import * as empty from './empty.js'
import * as evaluation from './eval.js'
import * as form from './form.js'
import * as markdown from './markdown.js'
import * as metrics from './metrics.js'
import * as multi from './multi.js'
import * as nav from './nav.js'
import * as perf from './perf.js'
import * as performance from './performance.js'
import * as prediction from './prediction.js'
import * as reportDetail from './reportDetail.js'
import * as reports from './reports.js'
import * as single from './single.js'
import * as tabs from './tabs.js'
import * as tasks from './tasks.js'
import * as trace from './trace.js'
import type { Dict, Locale } from './types.js'
import * as viewer from './viewer.js'

export type { Dict, Locale }

const en: Dict = {
  nav: nav.en,
  single: single.en,
  multi: multi.en,
  eval: evaluation.en,
  perf: perf.en,
  benchmarks: benchmarks.en,
  prediction: prediction.en,
  common: common.en,
  markdown: markdown.en,
  charts: charts.en,
  trace: trace.en,
  reports: reports.en,
  reportDetail: reportDetail.en,
  metrics: metrics.en,
  compare: compare.en,
  dashboard: dashboard.en,
  performance: performance.en,
  tasks: tasks.en,
  tabs: tabs.en,
  form: form.en,
  empty: empty.en,
  viewer: viewer.en,
}

const zh: Dict = {
  nav: nav.zh,
  single: single.zh,
  multi: multi.zh,
  eval: evaluation.zh,
  perf: perf.zh,
  benchmarks: benchmarks.zh,
  prediction: prediction.zh,
  common: common.zh,
  markdown: markdown.zh,
  charts: charts.zh,
  trace: trace.zh,
  reports: reports.zh,
  reportDetail: reportDetail.zh,
  metrics: metrics.zh,
  compare: compare.zh,
  dashboard: dashboard.zh,
  performance: performance.zh,
  tasks: tasks.zh,
  tabs: tabs.zh,
  form: form.zh,
  empty: empty.zh,
  viewer: viewer.zh,
}

const translations: Record<Locale, Dict> = { en, zh }

/**
 * Raw, nested translation dictionaries keyed by locale.
 *
 * Exposed (in addition to `lookupTranslation`) so tooling such as the locale
 * key drift checker can compare the key sets of different locales. Consumers
 * MUST treat the returned structure as read-only.
 */
export const localeDictionaries: Readonly<Record<Locale, Dict>> = translations

function lookup(locale: Locale, path: string): string | undefined {
  const keys = path.split('.')
  let node: string | Dict = translations[locale]
  for (const key of keys) {
    if (typeof node === 'string') return undefined
    const next: string | Dict | undefined = (node as Dict)[key]
    if (next === undefined) return undefined
    node = next
  }
  return typeof node === 'string' ? node : undefined
}

export function lookupTranslation(locale: Locale, path: string): string {
  return lookup(locale, path) ?? lookup('en', path) ?? path
}
