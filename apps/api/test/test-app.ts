import { type CreateAppOptions, createApp } from '../src/app.js'

export const TEST_V2_CURSOR_SECRET = 'databench-api-v2-test-cursor-secret'

export function createTestApp(options: CreateAppOptions = {}) {
  return createApp({
    v2CursorSecret: TEST_V2_CURSOR_SECRET,
    ...options,
  })
}
