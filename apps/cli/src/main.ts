import { EXIT, exitCodeFor } from './exit.js'
import { emitError } from './output.js'
import { dispatch, parseGlobal } from './router.js'

export async function run(argv: readonly string[]): Promise<number> {
  try {
    // parseGlobal itself can throw (e.g. a value flag missing its value), so it
    // must run inside the try to yield a clean error envelope + exit code.
    const { flags, rest } = parseGlobal(argv)
    await dispatch(rest, flags)
    return EXIT.ok
  } catch (error) {
    // Flags aren't known if parseGlobal threw; default to indented output.
    emitError(error, false)
    return exitCodeFor(error)
  }
}
