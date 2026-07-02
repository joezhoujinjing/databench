#!/usr/bin/env node
import { run } from './main.js'

// Use exitCode (not exit()) so buffered stdout/stderr flush before the process ends.
process.exitCode = await run(process.argv.slice(2))
