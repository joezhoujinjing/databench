import type { ParseArgsConfig } from 'node:util'
import type { GlobalFlags } from './config.js'

export type OptionsConfig = NonNullable<ParseArgsConfig['options']>

// `parseArgs` yields string | boolean, or string[] for `multiple: true` options.
export type Values = Record<string, string | boolean | string[] | undefined>

export interface CommandCtx {
  readonly positionals: string[]
  readonly values: Values
  readonly flags: GlobalFlags
}

// Returned by a handler that has already written its own output (e.g. `dataset
// export` streaming NDJSON) to tell the router not to JSON-wrap anything.
export const STREAMED: unique symbol = Symbol('streamed')

// A handler returns the value to print as JSON, or the STREAMED sentinel.
export type Handler = (ctx: CommandCtx) => Promise<unknown>

export interface PositionalSpec {
  readonly name: string
  readonly required?: boolean
  readonly variadic?: boolean
}

// Declared shape of a verb's output, surfaced in `help --json` so agents know
// what to expect: 'json' = a single JSON value on stdout; 'ndjson' = a raw
// newline-delimited JSON stream (the documented exception to JSON-everywhere).
export type OutputKind = 'json' | 'ndjson'

export interface Verb {
  readonly summary: string
  readonly options: OptionsConfig
  readonly positionals?: readonly PositionalSpec[]
  readonly output?: OutputKind
  readonly run: Handler
}

export interface CommandGroup {
  readonly summary: string
  readonly verbs: Record<string, Verb>
  // When set, `<noun> <positional>` (no matching verb) routes to this verb.
  readonly defaultVerb?: string
}
