/**
 * CLI entry tests (spawn the real bin/sema.mjs against the compiled lib):
 * version/help, usage errors, and exit-code discipline.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

test('cli: reindex loads the persisted index before refreshing', async () => {
  const root = mkdtempSync(join(process.cwd(), '.sema-cli-root-'))
  const dataDir = mkdtempSync(join(process.cwd(), '.sema-cli-data-'))
  try {
    writeFileSync(join(root, 'a.ts'), 'export function persistedEntry() { return 1 }', 'utf8')
    const configArgs = ['--root', root, '--data-dir', dataDir, '--provider', 'lexical', '--dim', '256', '--json']

    const indexed = await run([...configArgs, 'index'], root)
    assert.equal(indexed.code, 0, indexed.stderr)

    const refreshed = await run([...configArgs, 'reindex'], root)
    assert.equal(refreshed.code, 0, refreshed.stderr)
    const result = JSON.parse(refreshed.stdout) as { mode: string; added: number; unchanged: number; files: number }
    assert.equal(result.mode, 'incremental')
    assert.equal(result.added, 0)
    assert.equal(result.unchanged, 1)
    assert.equal(result.files, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('cli: stats loads the persisted index before reporting state', async () => {
  const root = mkdtempSync(join(process.cwd(), '.sema-cli-root-'))
  const dataDir = mkdtempSync(join(process.cwd(), '.sema-cli-data-'))
  try {
    writeFileSync(join(root, 'a.ts'), 'export function persistedStatsEntry() { return 1 }', 'utf8')
    const configArgs = ['--root', root, '--data-dir', dataDir, '--provider', 'lexical', '--dim', '256', '--json']

    const indexed = await run([...configArgs, 'index'], root)
    assert.equal(indexed.code, 0, indexed.stderr)

    const stats = await run([...configArgs, 'stats'], root)
    assert.equal(stats.code, 0, stats.stderr)
    const result = JSON.parse(stats.stdout) as { files: number; chunks: number; built: boolean }
    assert.equal(result.files, 1)
    assert.ok(result.chunks > 0)
    assert.equal(result.built, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  }
})
