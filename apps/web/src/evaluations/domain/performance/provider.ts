export type ProviderResolution = {
  readonly protocol: string
  readonly provider: string
  readonly source: 'custom-fallback' | 'host-detection' | 'metadata'
}

export type ProviderResolutionInput = {
  readonly api_host?: string | null | undefined
  readonly api_type?: string | null | undefined
  readonly basic_info?: Record<string, string> | null | undefined
  readonly protocol?: string | null | undefined
  readonly provider?: string | null | undefined
}

const KNOWN_HOSTS: Readonly<Record<string, string>> = {
  'api.anthropic.com': 'Anthropic',
  'api.deepseek.com': 'DeepSeek',
  'api.groq.com': 'Groq',
  'api.mistral.ai': 'Mistral',
  'api.moonshot.cn': 'Moonshot',
  'api.openai.com': 'OpenAI',
  'api.together.xyz': 'Together',
  'dashscope-intl.aliyuncs.com': 'DashScope',
  'dashscope.aliyuncs.com': 'DashScope',
  'generativelanguage.googleapis.com': 'Google',
  'openrouter.ai': 'OpenRouter',
}

function readInfo(input: ProviderResolutionInput, key: string): string | undefined {
  const value = input.basic_info?.[key]?.trim()
  return value ? value : undefined
}

function hostname(value: string | undefined): string | undefined {
  if (!value) return undefined
  for (const candidate of [value, `http://${value}`]) {
    try {
      const host = new URL(candidate).hostname.toLowerCase()
      if (host) return host
    } catch {}
  }
  return undefined
}

export function resolvePerformanceProvider(input: ProviderResolutionInput): ProviderResolution {
  const protocol = input.protocol?.trim() || readInfo(input, 'Protocol') || 'OpenAI-compatible'
  const explicit = input.provider?.trim() || readInfo(input, 'Provider')
  if (explicit) return { protocol, provider: explicit, source: 'metadata' }
  const host = hostname(
    input.api_host?.trim() || readInfo(input, 'API Host') || readInfo(input, 'API URL'),
  )
  if (host) {
    for (const [known, provider] of Object.entries(KNOWN_HOSTS)) {
      if (host === known || host.endsWith(`.${known}`)) {
        return { protocol, provider, source: 'host-detection' }
      }
    }
  }
  return { protocol, provider: 'Custom', source: 'custom-fallback' }
}
