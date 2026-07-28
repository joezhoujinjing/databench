import { AlertTriangle, Braces, ChevronDown, ChevronRight, Maximize2, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import 'katex/dist/katex.min.css'
import { useTranslation } from 'react-i18next'
import { evalScopeClient } from '../../api/client.js'
import type { ContentBlock } from '../../api/schemas.js'
import { LazyCodeBlock } from './LazyCodeBlock.js'

const SAFE_DATA_URI =
  /^data:(?:image\/(?:png|jpeg|gif|webp)|audio\/(?:mpeg|wav|ogg)|video\/(?:mp4|webm|ogg));base64,[A-Za-z0-9+/=\s]+$/u
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u

type MediaKind = 'audio' | 'image' | 'video'

function mediaMime(kind: MediaKind, format: string | undefined): string {
  const normalized = format?.toLowerCase()
  if (kind === 'image') {
    if (normalized === 'png') return 'image/png'
    if (normalized === 'gif') return 'image/gif'
    if (normalized === 'webp') return 'image/webp'
    return 'image/jpeg'
  }
  if (kind === 'audio') {
    if (normalized === 'wav') return 'audio/wav'
    if (normalized === 'ogg') return 'audio/ogg'
    return 'audio/mpeg'
  }
  if (normalized === 'webm') return 'video/webm'
  if (normalized === 'ogg' || normalized === 'ogv') return 'video/ogg'
  return 'video/mp4'
}

export function resolveSafeMediaSource(
  source: string,
  kind: MediaKind,
  format?: string,
): string | null {
  const value = source.trim()
  if (SAFE_DATA_URI.test(value)) return value
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) || value.startsWith('//')) return null
  const compact = value.replace(/\s/gu, '')
  if (compact.length >= 64 && BASE64.test(compact)) {
    return `data:${mediaMime(kind, format)};base64,${compact}`
  }
  try {
    return evalScopeClient.mediaUrl(value)
  } catch {
    return null
  }
}

function SafeMedia({
  alt = '',
  format,
  kind,
  source,
}: {
  readonly alt?: string | undefined
  readonly format?: string | undefined
  readonly kind: MediaKind
  readonly source: string
}) {
  const { t } = useTranslation()
  const src = resolveSafeMediaSource(source, kind, format)
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)
  if (src === null || failed) {
    return (
      <div
        className="my-2 flex items-center gap-2 rounded-[5px] border border-warning/35 bg-warning/5 px-3 py-2 text-warning text-xs"
        role="status"
      >
        <AlertTriangle aria-hidden="true" size={13} />
        {t('evaluations.single.mediaUnavailable')}
      </div>
    )
  }
  if (kind === 'audio') {
    return (
      <audio className="my-2 w-full" controls onError={() => setFailed(true)} src={src}>
        <track kind="captions" />
      </audio>
    )
  }
  if (kind === 'video') {
    return (
      <video
        className="my-2 max-h-[28rem] max-w-full rounded-[5px] border border-border bg-black"
        controls
        onError={() => setFailed(true)}
        src={src}
      >
        <track kind="captions" />
      </video>
    )
  }
  return (
    <>
      <button
        aria-label={t('evaluations.single.openImage')}
        className="group relative my-2 block max-w-full overflow-hidden rounded-[5px] border border-border"
        onClick={() => setOpen(true)}
        type="button"
      >
        <img
          alt={alt}
          className="max-h-[24rem] max-w-full object-contain transition-transform group-hover:scale-[1.01]"
          onError={() => setFailed(true)}
          src={src}
        />
        <Maximize2
          aria-hidden="true"
          className="absolute right-2 bottom-2 text-white drop-shadow"
          size={16}
        />
      </button>
      {open ? (
        <div
          aria-label={t('evaluations.single.imagePreview')}
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-8"
          role="dialog"
        >
          <img alt={alt} className="max-h-full max-w-full object-contain" src={src} />
          <button
            aria-label={t('evaluations.single.closeImage')}
            className="absolute top-5 right-5 inline-flex size-11 items-center justify-center rounded-full border border-white/30 bg-black/60 text-white"
            onClick={() => setOpen(false)}
            type="button"
          >
            <X aria-hidden="true" size={18} />
          </button>
        </div>
      ) : null}
    </>
  )
}

const markdownComponents: Components = {
  a: ({ children, href }) => {
    const safe = href !== undefined && /^https?:\/\//u.test(href)
    return safe ? (
      <a
        className="text-primary underline underline-offset-2"
        href={href}
        rel="noopener noreferrer"
        target="_blank"
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    )
  },
  code: ({ children, className }) => {
    const language = /language-([\w#+-]+)/u.exec(className ?? '')?.[1]
    return language === undefined ? (
      <code className="rounded bg-background/70 px-1.5 py-0.5 font-mono text-[0.86em]">
        {children}
      </code>
    ) : (
      <LazyCodeBlock language={language} value={String(children)} />
    )
  },
  img: ({ alt, src }) =>
    typeof src === 'string' ? <SafeMedia alt={alt ?? ''} kind="image" source={src} /> : null,
  pre: ({ children }) => <div className="not-prose my-3">{children}</div>,
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto rounded-[5px] border border-border">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  td: ({ children }) => <td className="border-border border-t px-3 py-2 align-top">{children}</td>,
  th: ({ children }) => (
    <th className="bg-surface-soft px-3 py-2 text-left font-medium">{children}</th>
  ),
}

export function RichContent({ content }: { readonly content: string }) {
  if (content === '') return null
  return (
    <div className="evaluation-rich-content max-w-none break-words text-sm leading-7">
      <ReactMarkdown
        components={markdownComponents}
        rehypePlugins={[rehypeKatex]}
        remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

export function ReasoningBlock({
  text,
  tokens,
}: {
  readonly text: string
  readonly tokens?: number | undefined
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <div className="mb-3 overflow-hidden rounded-[5px] border border-violet-400/25 bg-violet-400/5">
      <button
        aria-expanded={open}
        className="flex min-h-10 w-full items-center gap-2 px-3 text-left font-medium text-violet-200 text-xs"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {open ? (
          <ChevronDown aria-hidden="true" size={13} />
        ) : (
          <ChevronRight aria-hidden="true" size={13} />
        )}
        {open
          ? t('evaluations.prediction.hideReasoning')
          : t('evaluations.prediction.showReasoning')}
        <span className="font-normal text-muted-foreground">
          {tokens === undefined ? `${text.length} chars` : `${tokens} tokens`}
        </span>
      </button>
      {open ? (
        <div className="border-violet-400/20 border-t px-3 py-3">
          <RichContent content={text} />
        </div>
      ) : null}
    </div>
  )
}

export function ContentBlocks({
  blocks,
  includeReasoning = false,
}: {
  readonly blocks: readonly ContentBlock[]
  readonly includeReasoning?: boolean
}) {
  const rendered: ReactNode[] = []
  const occurrences = new Map<string, number>()
  blocks.forEach((block) => {
    const signature = JSON.stringify(block)
    const occurrence = occurrences.get(signature) ?? 0
    occurrences.set(signature, occurrence + 1)
    const key = `${block.type}:${signature}:${occurrence}`
    if (block.type === 'text' && block.text)
      rendered.push(<RichContent content={block.text} key={key} />)
    else if (block.type === 'reasoning' && includeReasoning && block.reasoning) {
      rendered.push(
        <ReasoningBlock key={key} text={block.reasoning} tokens={block.reasoning_tokens} />,
      )
    } else if (block.type === 'image' && block.image) {
      rendered.push(<SafeMedia format={block.format} key={key} kind="image" source={block.image} />)
    } else if (block.type === 'audio' && block.audio) {
      rendered.push(<SafeMedia format={block.format} key={key} kind="audio" source={block.audio} />)
    } else if (block.type === 'video' && block.video) {
      rendered.push(<SafeMedia format={block.format} key={key} kind="video" source={block.video} />)
    } else if (block.type === 'data') {
      rendered.push(
        <pre
          className="my-2 max-h-72 overflow-auto rounded-[5px] border border-border bg-background/65 p-3 font-mono text-xs"
          key={key}
        >
          <Braces aria-hidden="true" className="mb-2 text-muted-foreground" size={14} />
          {JSON.stringify(block.data ?? block, null, 2)}
        </pre>,
      )
    } else {
      rendered.push(
        <pre
          className="my-2 max-h-72 overflow-auto rounded-[5px] border border-warning/30 bg-warning/5 p-3 font-mono text-xs"
          key={key}
        >
          <Braces aria-hidden="true" className="mb-2 text-warning" size={14} />
          {JSON.stringify(block, null, 2)}
        </pre>,
      )
    }
  })
  return <>{rendered}</>
}
