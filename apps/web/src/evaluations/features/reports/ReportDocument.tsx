import { ExternalLink, FileCode2, LoaderCircle } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '@/components/ui/alert.js'
import { Button } from '@/components/ui/button.js'
import { evalScopeClient } from '../../api/client.js'
import type { GeneratedDocumentDescriptor } from '../../api/schemas.js'
import { SafeGeneratedDocumentFrame } from '../../components/SafeGeneratedDocumentFrame.js'
import { SafeReportLink } from '../../components/SafeReportLink.js'

export function ReportDocument({ reportName }: { readonly reportName: string }) {
  const { t } = useTranslation()
  const [document, setDocument] = useState<GeneratedDocumentDescriptor | null>(null)
  const [visible, setVisible] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const load = async () => {
    if (document !== null) {
      setVisible((value) => !value)
      return
    }
    setLoading(true)
    setError('')
    try {
      setDocument(
        await evalScopeClient.request('reportsHtml', { query: { report_name: reportName } }),
      )
      setVisible(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('evaluations.common.loadError'))
    } finally {
      setLoading(false)
    }
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={loading} onClick={() => void load()} size="sm" variant="outline">
          {loading ? (
            <LoaderCircle aria-hidden="true" className="animate-spin" size={14} />
          ) : (
            <FileCode2 aria-hidden="true" size={14} />
          )}
          {visible
            ? t('evaluations.reportDetail.hideHtml')
            : t('evaluations.reportDetail.viewHtml')}
        </Button>
        {document ? (
          <SafeReportLink document={document}>
            <ExternalLink aria-hidden="true" size={14} />
            {t('evaluations.common.openNewTab')}
          </SafeReportLink>
        ) : null}
      </div>
      {error ? (
        <Alert className="border-danger/30 text-danger" role="alert">
          {error}
        </Alert>
      ) : null}
      {visible && document ? (
        <SafeGeneratedDocumentFrame
          document={document}
          title={t('evaluations.reportDetail.viewHtml')}
        />
      ) : null}
    </div>
  )
}
