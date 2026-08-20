/**
 * Shared test helpers: throwaway workspaces and a small default engine config.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveConfig, type PluginConfig } from '../src/config.ts'
import type { EngineConfig } from '../src/engine/types.ts'

export interface Workspace {
  root: string
  /** Absolute paths of the created files. */
  paths: string[]
  /** Root-relative (forward-slash) file names. */
  rels: string[]
  cleanup: () => Promise<void>
}

export async function makeWorkspace(files: Record<string, string>): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), 'sema-test-'))
  const paths: string[] = []
  const rels: string[] = []
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(root, rel)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content, 'utf8')
      paths.push(abs)
      rels.push(rel.replace(/\\/g, '/'))
    }
    return {
      root,
      paths,
      rels,
      cleanup: () => rm(root, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

/** A small, fast engine config for tests (local lexical provider). */
export function testConfig(root: string, extra: Partial<PluginConfig> = {}): EngineConfig {
  return resolveConfig(
    {
      root,
      provider: { kind: 'lexical', dimension: 256 },
      autosave: false,
      autoIndex: false,
      watch: false,
      topK: 10,
      maxFiles: 2000,
      maxChunks: 10_000,
      ...extra,
    },
    root,
  )
}
