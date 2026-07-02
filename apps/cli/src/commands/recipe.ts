import { readFile } from 'node:fs/promises'
import { optString, parseJsonFlag, requirePositional } from '../args.js'
import { withWorkspace } from '../runtime.js'
import type { CommandGroup } from '../types.js'

export const recipeCommands: CommandGroup = {
  summary: 'Materialize reproducible dataset mixtures from a recipe',
  verbs: {
    materialize: {
      summary: 'Materialize a recipe JSON file into a new dataset version',
      positionals: [{ name: 'file', required: true }],
      output: 'json',
      options: { ref: { type: 'string' } },
      run: ({ positionals, values, flags }) => {
        const path = requirePositional(positionals, 0, 'recipe materialize: <file>')
        const ref = optString(values, 'ref')
        return withWorkspace(flags, async (workspace) => {
          // Mirror apps/api: plain JSON.parse of the recipe, then materialize
          // (which runs parseRecipe internally) — same fingerprint as the API.
          const recipe = parseJsonFlag(await readFile(path, 'utf8'), 'recipe file')
          const output = await workspace.materialize(recipe, ref !== undefined ? { ref } : {})
          return output.manifest
        })
      },
    },
  },
}
