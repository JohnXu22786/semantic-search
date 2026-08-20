#!/usr/bin/env node
/**
 * CLI launcher for dsh-semantic-search.
 *
 * The CLI drives the compiled engine at ../lib/cli.js (see `npm run build`).
 * It is separate from the plugin entry (src/index.ts) so it never imports the
 * dsh/cordis tool layer.
 */
import { runCli } from '../lib/cli.js'

runCli(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    process.stderr.write(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
