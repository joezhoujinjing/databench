// Re-exported so apps/api can build its v2 store config from the same source as
// Workspace without importing @databench/store directly.
export { v2ObjectStoreConfigFromEnv } from '@databench/store'
export * from './v2/index.js'
