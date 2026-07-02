import { readFile } from 'node:fs/promises'
import {
  BadInputError,
  EXTRACTOR_PRESETS,
  type Extractor,
  parseExtractor,
  parseVocabularyInput,
  resolveExtractor,
} from '@databench/schema'
import { optString, pagination, parseJsonFlag, requirePositional, requireString } from '../args.js'
import { withWorkspace } from '../runtime.js'
import type { CommandGroup, Values } from '../types.js'

// Parse the optional --extractor JSON flag into an Extractor, or null if absent.
function extractorFlag(values: Values): Extractor | null {
  const raw = optString(values, 'extractor')
  return raw === undefined ? null : parseExtractor(parseJsonFlag(raw, '--extractor'))
}

export const vocabCommands: CommandGroup = {
  summary: 'Derive, curate, and apply controlled vocabularies',
  verbs: {
    list: {
      summary: 'List vocabularies (name/dimension/status/term counts)',
      positionals: [],
      output: 'json',
      options: { limit: { type: 'string' }, offset: { type: 'string' } },
      run: ({ values, flags }) => {
        const { limit, offset } = pagination(values)
        return withWorkspace(flags, async (workspace) => {
          const all = await workspace.listVocabularies()
          return { total: all.length, limit, offset, items: all.slice(offset, offset + limit) }
        })
      },
    },

    show: {
      summary: 'Show a vocabulary by name or id',
      positionals: [{ name: 'nameOrId', required: true }],
      output: 'json',
      options: {},
      run: ({ positionals, flags }) => {
        const nameOrId = requirePositional(positionals, 0, 'vocab show: <nameOrId>')
        return withWorkspace(flags, (workspace) => workspace.getVocabulary(nameOrId))
      },
    },

    derive: {
      summary: 'Derive a draft vocabulary from a dataset dimension',
      positionals: [{ name: 'name', required: true }],
      output: 'json',
      options: {
        dataset: { type: 'string' },
        dimension: { type: 'string' },
        extractor: { type: 'string' },
      },
      run: ({ positionals, values, flags }) => {
        const name = requirePositional(positionals, 0, 'vocab derive: <name>')
        const dataset = requireString(values, 'dataset', 'vocab derive: --dataset')
        const dimension = requireString(values, 'dimension', 'vocab derive: --dimension')
        const extractor = extractorFlag(values) ?? EXTRACTOR_PRESETS[dimension]
        if (extractor === undefined) {
          throw new BadInputError(
            `no extractor preset for dimension ${JSON.stringify(dimension)}; supply one with --extractor`,
          )
        }
        return withWorkspace(flags, (workspace) =>
          workspace.deriveVocabulary(dataset, { name, dimension, extractor }),
        )
      },
    },

    curate: {
      summary: 'Save a curated vocabulary from a JSON file',
      positionals: [{ name: 'name', required: true }],
      output: 'json',
      options: { file: { type: 'string' } },
      run: ({ positionals, values, flags }) => {
        const name = requirePositional(positionals, 0, 'vocab curate: <name>')
        const file = requireString(values, 'file', 'vocab curate: --file')
        return withWorkspace(flags, async (workspace) => {
          const input = parseVocabularyInput(
            parseJsonFlag(await readFile(file, 'utf8'), 'vocab file'),
          )
          return workspace.saveVocabulary({ ...input, name })
        })
      },
    },

    normalize: {
      summary: 'Rewrite a dataset in place using a vocabulary; registers a new version',
      positionals: [{ name: 'name', required: true }],
      output: 'json',
      options: {
        dataset: { type: 'string' },
        ref: { type: 'string' },
        extractor: { type: 'string' },
      },
      run: ({ positionals, values, flags }) => {
        const name = requirePositional(positionals, 0, 'vocab normalize: <name>')
        const dataset = requireString(values, 'dataset', 'vocab normalize: --dataset')
        const ref = optString(values, 'ref')
        const override = extractorFlag(values)
        return withWorkspace(flags, async (workspace) => {
          const vocabulary = await workspace.getVocabulary(name)
          const extractor = resolveExtractor(vocabulary, override)
          const output = await workspace.normalizeVocabulary(dataset, vocabulary, {
            extractor,
            ...(ref !== undefined ? { ref } : {}),
          })
          return output.manifest
        })
      },
    },

    validate: {
      summary: 'Validate a dataset against a vocabulary; returns a summary + annotated version',
      positionals: [{ name: 'name', required: true }],
      output: 'json',
      options: {
        dataset: { type: 'string' },
        ref: { type: 'string' },
        extractor: { type: 'string' },
      },
      run: ({ positionals, values, flags }) => {
        const name = requirePositional(positionals, 0, 'vocab validate: <name>')
        const dataset = requireString(values, 'dataset', 'vocab validate: --dataset')
        const ref = optString(values, 'ref')
        const override = extractorFlag(values)
        return withWorkspace(flags, async (workspace) => {
          const vocabulary = await workspace.getVocabulary(name)
          const extractor = resolveExtractor(vocabulary, override)
          const result = await workspace.validateVocabulary(dataset, vocabulary, {
            extractor,
            ...(ref !== undefined ? { ref } : {}),
          })
          return { summary: result.summary, dataset: result.dataset.manifest }
        })
      },
    },
  },
}
