# dsh-semantic-search

[![CI](https://github.com/JohnXu22786/semantic-search/actions/workflows/ci.yml/badge.svg)](https://github.com/JohnXu22786/semantic-search/actions/workflows/ci.yml)

Local semantic code search for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) — and any Node script.

> **中文文档：[README.zh.md](README.zh.md)**

`sema` builds a **fragment-level index of a workspace**: source is tokenized by a
language-aware tokenizer (camel/snake/kebab splitting, CJK n-grams), chunked with
symbol-aware boundaries (functions/classes stay intact), and embedded into fixed
dimension vectors — **locally and dependency-free** by default (feature-hashed
lexical TF-IDF), or via any OpenAI-compatible embedding endpoint. Queries run a
**hybrid retrieval** (vector cosine + BM25, fused with reciprocal-rank fusion) over
the index, so meaning-based search works even when exact terms don't match.

Ships as a dsh plugin bundle — the `sema_search`, `sema_reindex` and `sema_stats`
tools on the harness tool registry — plus a standalone `sema` CLI.

---

## Highlights

- **Works offline by default** — the built-in lexical provider needs no network,
  no model download, no API key. Use it as a fast BM25-plus code search.
- **Symbol-aware chunking** — boundaries from a conservative per-language table
  (16 languages) keep functions/classes intact; a missed boundary degrades to a
  plain chunk rather than breaking.
- **CJK-aware tokenizer** — n-gram tokenization (default bigrams) aligns Chinese
  queries and documents without a segmentation library; full-width punctuation is
  folded, not treated as a hard break.
- **Hybrid retrieval with RRF** — vector cosine + BM25 channels are fused by
  reciprocal-rank fusion, so a document found by one channel still ranks.
- **Graceful degradation** — if a configured remote provider is unreachable, the
  index falls back to the local lexical provider (configurable via `allowFallback`).
- **Incremental refresh + file watching** — `sema_reindex` diffs by size+mtime,
  and an optional watcher keeps the index live.
- **Persistence** — the index is saved to `<root>/.sema` atomically (JSON metadata
  + binary vectors), with staleness detection when the provider/dimension changes.
- **Deterministic** — the same workspace and options produce the same index and
  the same ranked answers.

## Supported languages

TypeScript, JavaScript, Python, Go, Rust, Java, Kotlin, Scala, C, C++, C#, Objective-C,
Ruby, PHP, Swift, Bash, plus common data/markup formats (JSON, YAML, TOML, Markdown,
HTML, XML...).

---

## Installation

### As a dsh bundle

The package declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`. The
patch inserts one plugin row that mounts the bundle and registers
`sema_search` / `sema_reindex` / `sema_stats` on `ctx.tools`.

```sh
# from npm (name reserved; publish pending access setup)
npm install -g dsh-semantic-search

# straight from this repository
dsh plugin --profile demo add github:JohnXu22786/semantic-search

# or from a local checkout
dsh plugin --profile demo add /path/to/semantic-search
```

### As a standalone CLI

```sh
npm install -g dsh-semantic-search   # or: npm run build && node bin/sema.mjs
sema --help
```

---

## CLI usage

```sh
sema index                build the full index from the workspace
sema reindex [--full]     incremental refresh (or full rebuild with --full)
sema search <query...>    hybrid vector + BM25 search, prints top hits
sema stats [--json]       index health, provider, and sizing numbers
```

Global options:

```
--root <dir>          workspace root (default: current directory)
--data-dir <dir>      index storage directory (default: <root>/.sema)
--provider <kind>     embedding provider: lexical | openai (default: lexical)
--dim <n>             embedding dimension (lexical default: 4096; openai 0 = auto)
--base-url <url>      OpenAI-compatible embeddings endpoint base URL
--model <name>        embeddings model name (openai only)
--api-key <key>       API key (openai only; env: SEMA_EMBEDDING_API_KEY)
--top <n>             hits to print for search (default: 20)
--json                machine-readable output where supported
--help                show this help
```

### CLI exit codes

- `0` — success (including a search with zero hits and a `--version`/`--help` call).
- `1` — a runtime failure (config error, build/index/search error).
- `2` — a usage error: unknown command, unknown flag, or a missing query.

## Configuration

The plugin is configurable through the bundle row's `config` (see
`cordis.patch.yml` for an example), the CLI flags above, or defaults in code:

| Option | Default | Meaning |
| --- | --- | --- |
| `root` | cwd | workspace root to index |
| `dataDir` | `.sema` | index storage directory |
| `provider.kind` | `lexical` | `lexical` (offline) or `openai` |
| `provider.dimension` | `0` (lexical: 4096) | embedding dimension; `0` = auto-infer from the endpoint |
| `provider.baseUrl` | `https://api.openai.com/v1` | OpenAI-compatible endpoint root |
| `provider.model` | `text-embedding-3-small` | embedding model name |
| `provider.apiKeyEnv` | `SEMA_EMBEDDING_API_KEY` | env var holding the API key |
| `allowFallback` | `true` | fall back to the lexical provider when a remote one fails |
| `include` / `ignore` | defaults | glob sets of files to index / skip |
| `maxLinesPerChunk` | `80` | hard chunk size upper bound |
| `nGram` | `2` | CJK n-gram size (`1` disables n-gramming) |
| `topK` | `20` | hits returned by default |
| `rrfK` | `60` | RRF fusion constant |
| `vectorK` | `300` | candidates per channel before fusion |
| `autosave` | `true` | persist the index after builds |
| `autoIndex` | `true` | build lazily on first search |
| `watch` | `true` | watch the workspace for changes |

## Development

```sh
npm ci
npm test          # build + run the node:test suite (76 tests)
npm run typecheck
npm run build     # tsc -> lib/
```

---

## License

MIT — see [LICENSE](LICENSE). © 2026 dsh-semantic-search contributors.
