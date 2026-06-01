# ContextWeaver

<p align="center">
  <strong>🧵 为 AI Agent 精心编织的代码库上下文引擎</strong>
</p>

<p align="center">
  <em>Semantic Code Retrieval for AI Agents — Hybrid Search • Graph Expansion • Token-Aware Packing</em>
</p>

---

**ContextWeaver** 是一个面向 AI 代码助手的语义检索引擎。它把代码库索引成可检索的语义上下文，并通过混合搜索（向量 + 词法）、上下文扩展和 Token 感知打包，把更完整、更相关的代码片段交给 LLM。

<p align="center">
  <img src="docs/architecture.png" alt="ContextWeaver 架构概览" width="800" />
</p>

## ✨ 核心特性

- **混合检索**：向量召回理解语义，FTS 召回匹配函数名、类名等精确术语，并通过 RRF 融合。
- **AST 语义分片**：主包内置 JavaScript、Python、Go，并默认加载 TypeScript、Kotlin、Java、Rust 核心语言插件；其他语言通过按需插件增强。
- **上下文扩展**：支持同文件邻居、面包屑补全、导入文件扩展，减少只命中孤立片段的问题。
- **Token 感知打包**：合并相邻片段，控制上下文预算，避免输出过散或过长。
- **CLI + MCP 双入口**：既能作为命令行工具独立检索，也能作为 MCP Server 接入 Claude、Codex 等客户端。

## 📦 安装

### 环境要求

- Node.js >= 20 且 < 24（推荐 Node.js 22 LTS，不支持 Node 24）
- npm >= 10

### 安装主包

```bash
npm install -g @alistar.max/contextweaver
```

主包默认具备 JavaScript、Python、Go 的 AST 分片能力，并会自动加载 TypeScript、Kotlin、Java、Rust 默认核心语言插件。默认核心插件仍保持独立包边界，避免把更多 grammar 直接并入主包内置 runtime。

### 默认核心支持

安装主包后，下列语言默认可用，无需额外安装兼容分组包：

- TypeScript
- Kotlin
- Java
- Rust

### 按需安装语言包

这些包属于按需语言插件，用来补齐默认核心支持以外语言的 AST 分片能力。未安装语言插件时，对应语言仍可索引和搜索，但会回退为纯文本分片。

```bash
# C / C++ /  C#
npm install -g @alistar.max/contextweaver-lang-c
npm install -g @alistar.max/contextweaver-lang-cpp
npm install -g @alistar.max/contextweaver-lang-csharp

# PHP / Ruby  / Swift
npm install -g @alistar.max/contextweaver-lang-php
npm install -g @alistar.max/contextweaver-lang-ruby
npm install -g @alistar.max/contextweaver-lang-swift
```

`@alistar.max/contextweaver-lang-all` 仅作为补充型聚合包保留；README 推荐路径是主包默认核心支持 + 按需单语言插件。

## ⚙️ 初始化配置

```bash
contextweaver init
# 或使用别名
cw init
```

初始化后编辑 `~/.contextweaver/.env`。README 面向新用户只展示多 key 写法；即使你现在只有一个 key，也建议使用 `_KEYS` 变量，后续扩容只需要追加逗号分隔的新 key。

```bash
# Embedding API 配置（必需）
EMBEDDINGS_API_KEYS=your-api-key-here
EMBEDDINGS_BASE_URL=https://api.siliconflow.cn/v1/embeddings
EMBEDDINGS_MODEL=BAAI/bge-m3
EMBEDDINGS_MAX_CONCURRENCY=10
EMBEDDINGS_DIMENSIONS=1024

# Reranker 配置（必需）
RERANK_API_KEYS=your-api-key-here
RERANK_BASE_URL=https://api.siliconflow.cn/v1/rerank
RERANK_MODEL=BAAI/bge-reranker-v2-m3
RERANK_TOP_N=20

# 索引忽略模式（可选，逗号分隔）
# IGNORE_PATTERNS=.venv,node_modules

# 显式包含模式（可选，逗号分隔；仅用于放行未知扩展名）
# INCLUDE_PATTERNS=**/*.prompt,**/*.cue
```

`EMBEDDINGS_API_KEY` 与 `RERANK_API_KEY` 是旧变量名，运行时仍兼容；新配置推荐使用 `_KEYS`，支持逗号分隔多 key 和请求级轮转。

如果你希望在项目内持久化 include 规则，可在项目根目录创建 `.contextweaverinclude`，每行一个 glob 规则：

```bash
**/*.prompt
**/*.cue
```

## 🖥️ CLI 使用

### 1) 查看版本

```bash
contextweaver --version
cw --version
```

### 2) 初始化配置

```bash
contextweaver init
```

该命令会创建 `~/.contextweaver/.env`。如果文件已存在，不会覆盖现有配置。

### 3) 索引代码库

```bash
# 索引当前目录
contextweaver index .

# 强制重建当前目录索引
contextweaver index . --force

# 索引指定项目
contextweaver index /path/to/your/project --force
```

首次接入一个项目时，建议先手动执行一次 `--force` 索引。这样可以直接在终端观察 Embedding 进度、429 限流和配置错误。

### 4) 本地搜索

```bash
contextweaver search \
  --repo-path /path/to/your/project \
  --information-request "登录鉴权流程在哪里实现" \
  --technical-terms "AuthService,login,token"
```

参数说明：

| 参数 | 必需 | 说明 |
|------|------|------|
| `--repo-path` | 否 | 目标代码库目录，默认当前目录 |
| `--information-request` | 是 | 自然语言语义意图，描述你想找什么逻辑 |
| `--technical-terms` | 否 | 逗号分隔的精确术语，如类名、函数名、常量名 |
| `--zen` | 否 | 使用 MCP Zen 配置，当前默认开启 |

CLI 搜索适合本地调试、脚本化检索、CI 冒烟，以及在接 MCP 客户端之前确认索引和召回是否正常。

### 5) 启动 MCP Server

```bash
contextweaver mcp
```

通常不需要手动运行该命令；MCP 客户端会通过配置自动启动它。

### 6) 索引一致性检查

```bash
contextweaver doctor /path/to/your/project
contextweaver doctor /path/to/your/project --repair
```

`doctor` 用于检查向量索引和 FTS 索引是否一致。`--repair` 会删除 FTS 中没有对应向量记录的孤儿数据。

### 7) 检索反馈摘要

```bash
contextweaver feedback /path/to/your/project --days 7 --top 10
```

用于查看最近检索反馈、零命中率和高复用文件。

### 8) 离线调参

```bash
contextweaver tune tests/benchmark/fixtures/sample-auto-tune-dataset.jsonl \
  --target mrr \
  --k 1,3,5 \
  --top 3
```

该命令面向维护者和评测场景，用于 RRF 参数回放与自动调参。

## 🔌 MCP 集成

ContextWeaver 提供一个核心 MCP 工具：`codebase-retrieval`。

### Claude / OpenCode 配置

```json
{
  "mcpServers": {
    "contextweaver": {
      "command": "contextweaver",
      "args": ["mcp"]
    }
  }
}
```

### Codex CLI 配置

把下面内容加入 `~/.codex/config.toml`：

```toml
[mcp_servers.contextweaver]
type = "stdio"
command = "contextweaver"
args = ["mcp"]
startup_timeout_sec = 20
tool_timeout_sec = 30
```

### MCP 工具参数

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| `repo_path` | string | ✅ | 代码库根目录的绝对路径 |
| `information_request` | string | ✅ | 自然语言形式的语义意图描述 |
| `technical_terms` | string[] | ❌ | 精确技术术语，如类名、函数名、常量名 |
| `source_code_only` | boolean | ❌ | 排除文档/配置类语言 |
| `include_languages` | string[] | ❌ | 只包含指定语言 |
| `exclude_languages` | string[] | ❌ | 排除指定语言 |

MCP 模式下，`codebase-retrieval` 每次调用都会先执行自动索引检查：首次使用自动完整索引，后续自动增量索引。

## ✅ 测试流程

### 安装后冒烟

```bash
# 1) 确认 CLI 可执行
contextweaver --version

# 2) 初始化并配置 API
contextweaver init

# 3) 在目标仓库执行索引
cd /path/to/your/project
contextweaver index . --force

# 4) 执行一次检索
contextweaver search \
  --information-request "插件默认加载顺序在哪里定义" \
  --technical-terms "DEFAULT_PLUGIN_CANDIDATES,PluginLoader" \
  | tee /tmp/contextweaver-smoke.txt

# 5) 校验结果是否命中预期术语
rg "PluginLoader|DEFAULT_PLUGIN_CANDIDATES" /tmp/contextweaver-smoke.txt
```

### 开发者测试

```bash
# 构建
pnpm build

# 当前主测试流程
pnpm test

# Benchmark / 自动调参回归
pnpm run test:benchmark

# 单元 + Benchmark 汇总
pnpm run test:unit:all

# MCP E2E 冒烟
pnpm run test:e2e:mcp
```

如果在后台执行测试，建议给命令加超时，避免原生依赖安装、网络或 E2E 流程卡住：

```bash
timeout 60s pnpm test
```

macOS 默认没有 GNU `timeout` 时，可使用 `gtimeout`，或直接在任务运行器中配置 60s 超时。

## 🌍 多语言支持

ContextWeaver 当前采用“主包内置 + 默认核心插件 + 按需插件”三层能力模型：

- 主包内置 AST：JavaScript、Python、Go
- 默认核心插件 AST：TypeScript、Kotlin、Java、Rust
- 按需语言插件 AST：C#、C++、Ruby、C、PHP、Swift
- 未安装按需语言插件：自动回退为纯文本分片，仍可索引、检索和返回上下文

| 语言 | 默认支持层级 | 插件包 | Import 解析 | 扩展名 |
|------|--------------|------------|-------------|--------|
| JavaScript | 主包内置 | 内置 | ✅ | `.js`, `.jsx`, `.mjs` |
| Python | 主包内置 | 内置 | ✅ | `.py` |
| Go | 主包内置 | 内置 | ✅ | `.go` |
| TypeScript | 默认核心插件 | `@alistar.max/contextweaver-lang-typescript` | ✅ | `.ts`, `.tsx` |
| Kotlin | 默认核心插件 | `@alistar.max/contextweaver-lang-kotlin` | ✅ | `.kt` |
| Java | 默认核心插件 | `@alistar.max/contextweaver-lang-java` | ✅ | `.java` |
| Rust | 默认核心插件 | `@alistar.max/contextweaver-lang-rust` | ✅ | `.rs` |
| C# | 按需插件 | `@alistar.max/contextweaver-lang-csharp` | ✅ | `.cs`, `.csx` |
| C++ | 按需插件 | `@alistar.max/contextweaver-lang-cpp` | ✅ | `.cpp`, `.cc`, `.cxx`, `.hpp` |
| Ruby | 按需插件 | `@alistar.max/contextweaver-lang-ruby` | ✅ | `.rb` |
| C | 按需插件 | `@alistar.max/contextweaver-lang-c` | ✅ | `.c`, `.h` |
| PHP | 按需插件 | `@alistar.max/contextweaver-lang-php` | ✅ | `.php` |
| Swift | 按需插件 | `@alistar.max/contextweaver-lang-swift` | ✅ | `.swift` |
| Dart | 纯文本回退 | 当前无语言包 | ✅ | `.dart` |

C# Import 解析支持 `using`、`using static`、`global using`、别名导入，并兼容 `global::` 与 `@` 标识符写法。

## ⚙️ 配置参考

| 变量名 | 必需 | 默认值 | 描述 |
|--------|------|--------|------|
| `EMBEDDINGS_API_KEYS` | ✅ | - | Embedding API Key，逗号分隔，支持多 key 轮转 |
| `EMBEDDINGS_BASE_URL` | ✅ | - | Embedding API 地址 |
| `EMBEDDINGS_MODEL` | ✅ | - | Embedding 模型名称 |
| `EMBEDDINGS_MAX_CONCURRENCY` | ❌ | 10 | Embedding 并发数 |
| `EMBEDDINGS_DIMENSIONS` | ❌ | 1024 | 向量维度 |
| `RERANK_API_KEYS` | ✅ | - | Reranker API Key，逗号分隔，支持多 key 轮转 |
| `RERANK_BASE_URL` | ✅ | - | Reranker API 地址 |
| `RERANK_MODEL` | ✅ | - | Reranker 模型名称 |
| `RERANK_TOP_N` | ❌ | 20 | Rerank 返回数量 |
| `INCLUDE_PATTERNS` | ❌ | - | 额外包含模式，用于显式纳入未知扩展名 |
| `IGNORE_PATTERNS` | ❌ | - | 额外忽略模式 |

兼容说明：`EMBEDDINGS_API_KEY` 和 `RERANK_API_KEY` 是旧变量名，运行时仍兼容；新文档不再提供单 key 示例，推荐使用 `_KEYS`。

## 🧱 技术文档

README 只保留安装、配置、CLI、MCP 和测试入口。更细的工程内容请看独立文档：

- 开发者指南：`docs/developer/developer-guide.md`
- CLI 原生搜索规格：`docs/specs/2026-05-31-cli-native-search-spec.md`
- 检索准确率计划：`docs/plans/2026-02-11-retrieval-accuracy-p0-p1.md`
- 多 key 轮转设计：`docs/plans/2026-02-10-multi-key-round-robin.md`
- 插件包迁移记录：`docs/logs/plugin-packages-migration-2026-02-10.md`
- 发布流程：`docs/release/local-manual-release.md`

基础架构概览：

```text
索引: Crawler -> Processor -> SemanticSplitter -> Indexer -> VectorStore / SQLite
搜索: Query -> Vector + FTS Recall -> RRF Fusion -> Rerank -> GraphExpander -> ContextPacker
```

## 🐛 日志与调试

日志文件位于 `~/.contextweaver/logs/app.YYYY-MM-DD.log`。

```bash
LOG_LEVEL=debug contextweaver search --information-request "..."
```

## 📄 开源协议

本项目采用 MIT 许可证。

## 🙏 致谢

- [Tree-sitter](https://tree-sitter.github.io/tree-sitter/) - 高性能语法解析
- [LanceDB](https://lancedb.com/) - 嵌入式向量数据库
- [MCP](https://modelcontextprotocol.io/) - Model Context Protocol
- [SiliconFlow](https://siliconflow.cn/) - 推荐的 Embedding/Reranker API 服务

---

<p align="center">
  <sub>Made with ❤️ for AI-assisted coding</sub>
</p>
