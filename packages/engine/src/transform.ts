import type { z } from 'zod'

export type TransformParams = Record<string, unknown>
export type TransformFn<TResult = unknown> = {
  bivarianceHack(...inputs: unknown[]): TResult
}['bivarianceHack']

export interface BuildParamsResult<TParams = unknown> {
  readonly params: TParams | null
  readonly paramsDict: TransformParams
}

export interface Transform<TParams = unknown, TResult = unknown> {
  readonly fn: TransformFn<TResult>
  readonly name: string
  readonly version: string
  readonly paramsSchema: z.ZodType<TParams> | null
  buildParams(kwargs?: TransformParams): BuildParamsResult<TParams>
  toString(): string
}

export interface DefineTransformOptions<TParams> {
  readonly name: string
  readonly version?: string
  readonly params?: z.ZodType<TParams>
}

export function defineTransform<TParams = undefined, TResult = unknown>(
  options: DefineTransformOptions<TParams>,
  fn: TransformFn<TResult>,
): Transform<TParams, TResult> {
  const version = options.version ?? '1'
  const paramsSchema = options.params ?? null

  return {
    fn,
    name: options.name,
    version,
    paramsSchema,
    buildParams(kwargs: TransformParams = {}): BuildParamsResult<TParams> {
      if (paramsSchema === null) {
        const keys = Object.keys(kwargs)
        if (keys.length > 0) {
          throw new TypeError(
            `transform ${JSON.stringify(options.name)} takes no params but got: ${formatKeys(keys)}`,
          )
        }

        return { params: null, paramsDict: {} }
      }

      const params = paramsSchema.parse(kwargs)
      return {
        params,
        paramsDict: params as TransformParams,
      }
    },
    toString() {
      return `Transform(name=${JSON.stringify(options.name)}, version=${JSON.stringify(version)})`
    },
  }
}

function formatKeys(keys: readonly string[]): string {
  return `[${[...keys]
    .sort()
    .map((key) => `'${key}'`)
    .join(', ')}]`
}
