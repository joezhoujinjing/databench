#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { run } from './main.js'

// Load the monorepo-root .env (if present) so a local `databench` picks up
// DATABASE_URL / OSS_* without exporting them. Resolved by file location, not
// cwd; a no-op when absent (installed/deployed elsewhere set env directly).
const envFile = fileURLToPath(new URL('../../../.env', import.meta.url))
if (existsSync(envFile)) {
  process.loadEnvFile(envFile)
}

// Use exitCode (not exit()) so buffered stdout/stderr flush before the process ends.
process.exitCode = await run(process.argv.slice(2))
