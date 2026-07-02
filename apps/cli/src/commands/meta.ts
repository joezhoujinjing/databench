import {
  API_VERSION,
  SCHEMA_VERSION,
  serviceCapabilities,
  type VersionInfo,
} from '@databench/schema'
import { listTransforms } from '@databench/workspace'
import { withWorkspace } from '../runtime.js'
import type { CommandGroup } from '../types.js'
import { readServiceVersion } from '../version.js'

export const metaCommands: CommandGroup = {
  summary: 'Report service version, capabilities, and backend health',
  verbs: {
    version: {
      summary: 'Print API/service/schema versions (mirrors GET /version)',
      positionals: [],
      output: 'json',
      options: {},
      run: () =>
        Promise.resolve({
          api_version: API_VERSION,
          service_version: readServiceVersion(),
          schema_version: SCHEMA_VERSION,
        } satisfies VersionInfo),
    },

    capabilities: {
      summary: 'Print runtime capability flags (mirrors GET /capabilities)',
      positionals: [],
      output: 'json',
      options: {},
      run: () => Promise.resolve(serviceCapabilities({ transforms: listTransforms().length > 0 })),
    },

    doctor: {
      summary:
        'Probe the database and object store; reports {database,store} status so infra failures are distinguishable from a not-found ref',
      positionals: [],
      output: 'json',
      options: {},
      // Always exits 0 on a successful probe run — inspect the JSON report
      // (database.ok / store.ok) to see what, if anything, is unhealthy.
      run: ({ flags }) => withWorkspace(flags, (workspace) => workspace.check()),
    },
  },
}
