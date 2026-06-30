import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.{test,spec}.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.turbo/**'],
    testTimeout: 30_000,
  },
})
