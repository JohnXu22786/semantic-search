# dsh-semantic-search

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）以及任意 Node 脚本的本地语义代码搜索。

> **English documentation: [README.md](README.md)**

`sema` 为工作区构建**片段级索引**：源码经语言感知分词器（camel/snake/kebab 拆分、CJK n-gram）处理后，按**符号感知边界**切块（函数/类保持完整），再嵌入为定长向量——默认**完全本地、零依赖**（特征哈希的 TF-IDF），也可接入任意 OpenAI 兼容的 embedding 端点。查询基于该索引做**混合检索**（向量余弦 + BM25，用倒数排名融合 RRF 合并），即使关键词不完全一致也能按语义命中。

以 dsh 插件 bundle 形式交付——在 harness 工具注册表上注册 `sema_search`、`sema_reindex`、`sema_stats` 三个工具——并附带独立的 `sema` CLI。

---

## 特性一览

- **默认离线可用** —— 内置 lexical 提供方无需网络、无需下载模型、无需 API key；可当作快速 BM25 增强的代码搜索使用。
- **符号感知分块** —— 保守的按语言表（16 种语言）提供边界，函数/类保持完整；漏判边界时优雅退化为普通文本块。
- **CJK 感知分词** —— n-gram 分词（默认 bigram）让中文查询与文档无需分词库即可对齐；全角标点被折叠而非硬断。
- **RRF 混合检索** —— 向量余弦与 BM25 双通道经倒数排名融合，单通道命中的文档也能进入排序。
- **优雅降级** —— 远程 provider 不可达时索引自动回退到本地 lexical provider（可用 `allowFallback` 控制）。
- **增量刷新 + 文件监听** —— `sema_reindex` 按大小+mtime 差异更新，可选的 watcher 让索引保持新鲜。
- **持久化** —— 索引原子化保存到 `<root>/.sema`（JSON 元数据 + 二进制向量），provider/维度变化时自动检测失效。
- **确定性** —— 相同的工作区与配置产生相同的索引与排序结果。

## 支持的语言

TypeScript、JavaScript、Python、Go、Rust、Java、Kotlin、Scala、C、C++、C#、Objective-C、Ruby、PHP、Swift、Bash，以及常见数据/标记格式（JSON、YAML、TOML、Markdown、HTML、XML……）。

---

## 安装

### 作为 dsh bundle

本包声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`。补丁插入一行插件项，将 bundle 挂载到 `ctx.tools` 并注册 `sema_search` / `sema_reindex` / `sema_stats`。

```sh
# 从 npm（包名已保留；发布待访问权限配置完成后执行）
npm install -g dsh-semantic-search

# 或直接从此仓库安装
dsh plugin --profile demo add github:JohnXu22786/semantic-search

# 或使用本地检出目录
dsh plugin --profile demo add /path/to/semantic-search
```

### 作为独立 CLI

```sh
npm install -g dsh-semantic-search   # 或: npm run build && node bin/sema.mjs
sema --help
```

---

## CLI 用法

```sh
sema index               从工作区构建完整索引
sema reindex [--full]    增量刷新（或加 --full 全量重建）
sema search <query...>   混合向量+BM25 搜索，打印 top 命中
sema stats [--json]      索引健康度、provider 与规模数据
```

全局选项：

```
--root <dir>          工作区根目录（默认：当前目录）
--data-dir <dir>      索引存储目录（默认：<root>/.sema）
--provider <kind>     embedding provider：lexical | openai（默认：lexical）
--dim <n>             embedding 维度（lexical 默认 4096；openai 0=自动）
--base-url <url>      OpenAI 兼容 embeddings 端点根地址
--model <name>        embeddings 模型名（仅 openai）
--api-key <key>       API key（仅 openai；环境变量：SEMA_EMBEDDING_API_KEY）
--top <n>             search 打印的命中数（默认：20）
--json                输出机器可读结果（支持处）
--help                显示帮助
```

## 配置

可在 bundle 行的 `config`（示例见 `cordis.patch.yml`）、上面的 CLI 参数或代码默认值中配置：

| 选项 | 默认 | 含义 |
| --- | --- | --- |
| `root` | cwd | 待索引的工作区根目录 |
| `dataDir` | `.sema` | 索引存储目录 |
| `provider.kind` | `lexical` | `lexical`（离线）或 `openai` |
| `provider.dimension` | `0`（lexical: 4096） | embedding 维度；`0`=从端点自动推断 |
| `provider.baseUrl` | `https://api.openai.com/v1` | OpenAI 兼容端点根地址 |
| `provider.model` | `text-embedding-3-small` | embedding 模型名 |
| `provider.apiKeyEnv` | `SEMA_EMBEDDING_API_KEY` | 存放 API key 的环境变量名 |
| `allowFallback` | `true` | 远程 provider 失败时回退到 lexical |
| `include` / `ignore` | 默认 | 索引/忽略的 glob 集合 |
| `maxLinesPerChunk` | `80` | 分块大小硬上限 |
| `nGram` | `2` | CJK n-gram 大小（`1` 关闭 n-gram） |
| `topK` | `20` | 默认返回的命中数 |
| `rrfK` | `60` | RRF 融合常数 |
| `vectorK` | `300` | 融合前每通道候选数 |
| `autosave` | `true` | 构建后持久化索引 |
| `autoIndex` | `true` | 首次搜索时惰性构建 |
| `watch` | `true` | 监听工作区变更 |

## 开发

```sh
npm ci
npm test          # 构建 + 运行 node:test 套件（76 个测试）
npm run typecheck
npm run build     # tsc -> lib/
```

---

## 许可证

MIT —— 见 [LICENSE](LICENSE)。© 2026 dsh-semantic-search 贡献者。
