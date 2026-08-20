/**
 * CLI entry tests (spawn the real bin/sema.mjs against the compiled lib):
 * version/help, usage errors, and exit-code discipline.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const execFileP = promisify(execFile)
const BIN = fileURLToPath(new URL('../bin/sema.mjs', import.meta.url))

async function run(args: readonly string[], cwd: string) {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [BIN, ...args], { cwd })
    return { code: 0, stdout, stderr }
  } catch (caught) {
    const e = caught as { code?: number; stdout?: string; stderr?: string }
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

test('cli: --version prints the package version', async () => {
  const { code, stdout } = await run(['--version'], process.cwd())
  assert.equal(code, 0)
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/)
})

test('cli: --help prints usage and exits 0', async () => {
  const { code, stdout } = await run(['--help'], process.cwd())
  assert.equal(code, 0)
  assert.match(stdout, /sema <command> \[options\]/)
  assert.match(stdout, /search <query\.\.\.>/)
})

test('cli: an unknown command exits 2 with a hint', async () => {
  const { code, stderr } = await run(['bogus'], process.cwd())
  assert.equal(code, 2)
  assert.match(stderr, /unknown command: bogus/)
})

test('cli: search requires a query and exits 2 otherwise', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sema-cli-'))
  try {
    const { code, stderr } = await run(['search'], dir)
    assert.equal(code, 2)
    assert.match(stderr, /search requires a query/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
