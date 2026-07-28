import { z } from 'zod'
import { SWIFT_STUDIO_PATH } from '../api/client.js'

export type SwiftStudioFrameLocation =
  | { readonly supported: true; readonly source: typeof SWIFT_STUDIO_PATH }
  | { readonly reason: 'bearer-token' | 'cross-origin'; readonly supported: false }

const EmbeddedGradioConfigSchema = z
  .object({
    api_prefix: z.literal('/gradio_api'),
    mode: z.literal('blocks'),
    root: z.string().min(1),
    version: z.literal('5.50.0'),
  })
  .passthrough()

export interface SwiftStudioFrameSnapshot {
  readonly appElementPresent: boolean
  readonly customElementRegistered: boolean
  readonly gradioConfig: unknown
  readonly origin: string
}

export function resolveSwiftStudioFrameLocation(
  backendBase: string,
  browserOrigin: string,
  bearerToken = '',
): SwiftStudioFrameLocation {
  if (bearerToken.trim() !== '') return { reason: 'bearer-token', supported: false }
  try {
    const origin = new URL(browserOrigin).origin
    const backend = new URL(backendBase.trim() || '/', origin)
    if (backend.origin !== origin) return { reason: 'cross-origin', supported: false }
    return { source: SWIFT_STUDIO_PATH, supported: true }
  } catch {
    return { reason: 'cross-origin', supported: false }
  }
}

export function shouldRenderSwiftStudioFrame(options: {
  readonly frameLocation: SwiftStudioFrameLocation
  readonly querySucceeded: boolean
  readonly runtimeReady: boolean
}): boolean {
  return options.querySucceeded && options.runtimeReady && options.frameLocation.supported
}

export async function toggleSwiftStudioFullscreen(
  documentRef: Pick<Document, 'exitFullscreen' | 'fullscreenElement'>,
  container: Pick<HTMLElement, 'requestFullscreen'> | null,
): Promise<boolean> {
  if (container === null) return false
  try {
    if (documentRef.fullscreenElement === container) {
      await documentRef.exitFullscreen()
    } else {
      await container.requestFullscreen()
    }
    return true
  } catch {
    return false
  }
}

export function isSwiftStudioFrameBooted(snapshot: SwiftStudioFrameSnapshot): boolean {
  if (!snapshot.appElementPresent || !snapshot.customElementRegistered) return false
  const parsed = EmbeddedGradioConfigSchema.safeParse(snapshot.gradioConfig)
  if (!parsed.success) return false
  try {
    return (
      new URL(parsed.data.root, snapshot.origin).pathname.replace(/\/+$/u, '') === '/swift-studio'
    )
  } catch {
    return false
  }
}
