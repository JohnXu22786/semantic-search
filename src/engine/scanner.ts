/**
 * Recursive workspace scanning with include/ignore filtering, binary detection,
 * and size caps.
 *
 * The walk is iterative (explicit stack) in a deterministic order (entries
 * sorted by name). A file lands in the index when it:
 *   - is a file (not a symlink to a dir), is non-empty, and is under caps;
 *   - matches at least one `include` basename glob;
 *   - is not matched by any `ignore` rule;
 *   - contains no NUL bytes in its leading bytes (binary check).
 */

import { lstat, readFile, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { languageForPath } from './languages.ts'

export interface ScannedFile {
  /** Absolute path. */
  path: string
  /** Root-relative path, forward slashes. */
  rel: string
  language: string
  size: number
  mtimeMs: number
  content: string
}

export interface ScanOptions {
  root: string
  /** Basename globs; a file matches when at least one matches its basename. */
  include: string[]
  /** Exact segment names and/or glob patterns (matched against the rel path). */
  ignore: string[]
  maxFileBytes: number
  /** Stop adding files once this many files have been indexed. */
  maxFiles: number
  /** Stop adding files once their total content bytes exceed this. */
  maxTotalBytes: number
  /** Skip reading file content (metadata-only; used by incremental refresh). */
  readContent?: boolean
}

export interface ScanResult {
  files: ScannedFile[]
  /** True when scanning stopped early because a cap was reached. */
  truncated: boolean
  /** Files skipped: reason → count. */
  skipped: Map<string, number>
  /** Unreadable entries (permission, transient errors). */
  errors: string[]
}

/** Convert a glob (with `**` and `*`) into a RegExp. */
export function globToRegExp(pattern: string): RegExp {
  const fixed = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
  return new RegExp(`^${fixed}$`)
}

/** Whether an ignore rule swallows a rel path (forward-slash normalized). */
function isIgnored(rel: string, segments: string[], ignore: string[]): boolean {
  for (const rule of ignore) {
    if (rule.length === 0) continue
    if (rule.includes('*')) {
      if (globToRegExp(rule).test(rel)) return true
    } else if (segments.includes(rule)) {
      return true
    }
  }
  return false
}

/** Whether a basename matches at least one include glob. */
function isIncluded(basename: string, include: string[]): boolean {
  for (const pattern of include) {
    if (globToRegExp(pattern).test(basename)) return true
  }
  return false
}

/** Cheap binary detection: NUL bytes in the leading chunk. */
export function isBinaryContent(content: string): boolean {
  const head = content.slice(0, 8192)
  return head.includes('\u0000')
}

/**
 * Scan a workspace tree.
 *
 * Order is deterministic (sorted sibling names). When a cap is hit, scanning
 * stops and `truncated` is set; callers should surface this in stats so users
 * know the index is partial.
 */
export async function scanWorkspace(opts: ScanOptions): Promise<ScanResult> {
  const { root } = opts
  const files: ScannedFile[] = []
  const skipped = new Map<string, number>()
  const errors: string[] = []
  let truncated = false
  let totalBytes = 0
  const bump = (reason: string): void => {
    skipped.set(reason, (skipped.get(reason) ?? 0) + 1)
  }

  const stack: string[] = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      errors.push(`cannot read directory ${dir}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      const rel = relative(root, abs).split(sep).join('/')
      const segments = rel.split('/')
      if (isIgnored(rel, segments, opts.ignore)) continue

      if (entry.isDirectory()) {
        stack.push(abs)
        continue
      }
      if (!entry.isFile()) continue

      if (files.length >= opts.maxFiles) {
        truncated = true
        return { files, truncated, skipped, errors }
      }

      let stat
      try {
        stat = await lstat(abs)
      } catch (error) {
        errors.push(`cannot stat ${rel}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      if (!stat.isFile() || stat.size === 0) {
        if (!stat.isFile()) bump('non-file')
        else bump('empty')
        continue
      }
      if (stat.size > opts.maxFileBytes) {
        bump('too-large')
        continue
      }

      const language = languageForPath(abs)?.name ?? 'text'
      if (!isIncluded(entry.name, opts.include)) {
        bump('not-included')
        continue
      }

      if (opts.readContent === false) {
        if (totalBytes + stat.size > opts.maxTotalBytes) {
          truncated = true
          return { files, truncated, skipped, errors }
        }
        totalBytes += stat.size
        files.push({
          path: abs,
          rel,
          language,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          content: '',
        })
        continue
      }

      let content: string
      try {
        content = await readFile(abs, 'utf8')
      } catch (error) {
        errors.push(`cannot read ${rel}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      if (isBinaryContent(content)) {
        bump('binary')
        continue
      }
      const contentBytes = Buffer.byteLength(content, 'utf8')
      if (totalBytes + contentBytes > opts.maxTotalBytes) {
        truncated = true
        return { files, truncated, skipped, errors }
      }
      totalBytes += contentBytes

      files.push({
        path: abs,
        rel,
        language,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        content,
      })
    }
  }
  return { files, truncated, skipped, errors }
}
