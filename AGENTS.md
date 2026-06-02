## Project Overview

CodeRecall 是一个为 AI 代码助手设计的语义检索引擎，采用混合搜索（向量 + 词法）、智能上下文扩展和 Token 感知打包策略。通过 CLI 和 MCP Server 两种方式提供服务。

## Development Commands

```bash
# Build
pnpm build                    # 编译 TypeScript (tsup)，含 sourcemap
pnpm build:release            # 正式发布编译（无 sourcemap）

# Development
pnpm dev                      # Watch 模式开发
pnpm fmt                      # Biome 格式化并自动修复
pnpm biome check ./src        # Biome 仅检查不修复（CI 用）
pnpm tsc --noEmit             # TypeScript 类型检查（CI 用）

# Test — 全量回归
pnpm test                     # 语言支持解析器 + 全部 runtime 单测
pnpm test:runtime             # 运行单个 runtime 测试（registry.test.ts）
tsx tests/runtime/<name>.test.ts  # 运行任意单个测试
pnpm test:e2e:mcp             # MCP 端到端冒烟测试（先 build）
pnpm test:benchmark           # 离线 benchmark + 自动调参测试
pnpm test:unit:all            # pnpm test + test:benchmark

# Benchmark & Tuning
pnpm benchmark:offline        # 离线 Recall@K / MRR / nDCG 评测
pnpm benchmark:tune           # 自动调参（RRF 回放）

# CLI 命令
coderecall init            # 初始化配置文件 (~/.coderecall/.env)
coderecall index [path]    # 索引代码库（-f 强制重建）
coderecall search          # 本地检索
coderecall mcp             # 启动 MCP 服务端
coderecall doctor .        # 索引一致性审计（--repair 自动修复）
coderecall feedback .      # 隐式反馈闭环摘要（--days 7 --top 10）
coderecall tune <dataset>  # 离线自动调参（--target mrr --k 1,3,5）
```

## Architecture

### Monorepo 结构

pnpm workspace monorepo，根目录 `pnpm-workspace.yaml` 声明 `packages/*`。`packages/` 下为各语言插件包（lang-typescript、lang-rust 等），每个插件导出 `createRuntime()`。CI 使用 `pnpm install --frozen-lockfile`，Node 版本由 `.node-version` 固定为 22。

### Core Pipeline

```
索引: Crawler → Filter → Processor → SemanticSplitter → Indexer → VectorStore/SQLite
搜索: Query → Vector+FTS Recall → RRF Fusion → Rerank → GraphExpander → ContextPacker
```

### 配置加载（关键时序）

`src/config.ts` 必须在任何模块之前加载（`src/index.ts` 第 3 行 `import './config.js'`），它调用 `dotenv` 加载环境变量：

- **开发环境** (`NODE_ENV=development/dev`): 先加载 `cwd/.env`，回退到 `~/.coderecall/.env`
- **生产环境** (默认): 只加载 `~/.coderecall/.env`
- **MCP 模式**: 通过 `process.argv[2] === 'mcp'` 检测

所有模块通过 `src/config.ts` 导出的 getter 函数读取配置（`getEmbeddingConfig()`、`getRerankerConfig()`），**禁止直接读 `process.env`**。

### 环境变量

- `EMBEDDINGS_API_KEYS` (推荐) / `EMBEDDINGS_API_KEY` (兼容): Embedding API Key，KEYS 支持逗号分隔多 key 轮转
- `RERANK_API_KEYS` (推荐) / `RERANK_API_KEY` (兼容): Reranker API Key，同上
- `EMBEDDINGS_BASE_URL`, `EMBEDDINGS_MODEL`, `EMBEDDINGS_DIMENSIONS`, `EMBEDDINGS_MAX_CONCURRENCY`
- `RERANK_BASE_URL`, `RERANK_MODEL`, `RERANK_TOP_N`
- `IGNORE_PATTERNS`, `INCLUDE_PATTERNS`: 额外忽略/包含模式
- `LOG_LEVEL=debug`: 开启调试日志，输出到 `~/.coderecall/logs/app.YYYY-MM-DD.log`

## Key Modules

| Module | Location | Responsibility |
|--------|----------|----------------|
| **CLI Entry** | `src/index.ts` | cac CLI 入口，6 个命令: init/index/search/mcp/doctor/feedback/tune |
| **Config** | `src/config.ts` | 环境变量加载 + 导出型 getter，必须最先 import |
| **SearchService** | `src/search/SearchService.ts` | 流水线编排：召回 → 融合 → Rerank → 扩展 → 打包 |
| **GraphExpander** | `src/search/GraphExpander.ts` | E1/E2/E3 三阶段扩展，衰减系数控制上下文相关性 |
| **ContextPacker** | `src/search/ContextPacker.ts` | 同文件段落合并 + Token 预算控制 |
| **SemanticSplitter** | `src/chunking/SemanticSplitter.ts` | AST 语义分片，Dual-Text、Gap-Aware 合并 |
| **API Clients** | `src/api/` | Embedding/Reranker HTTP 客户端，速率限制恢复、多 Key 轮转 |
| **VectorStore** | `src/vectorStore/index.ts` | LanceDB 适配层，表按 `projectId` 隔离 |
| **Database** | `src/db/index.ts` | SQLite + FTS5 元数据和全文索引 |
| **Indexer** | `src/indexer/index.ts` | 自愈索引编排：hash 变化检测 → chunk → embedding → 写入 |
| **MCP Server** | `src/mcp/server.ts` | 单工具 `codebase-retrieval`，首次查询自动触发索引 |
| **Scanner** | `src/scanner/index.ts` | scan() 编排 crawler → filter → processor，支持进度回调 |

### Scanner 流水线

```
scanner/
├── crawler.ts   — fdir 遍历，.gitignore 感知
├── filter.ts    — 扩展名白名单 + INCLUDE_PATTERNS + IGNORE_PATTERNS
├── processor.ts — 读文件、xxhash 指纹、变更检测 (added/modified/unchanged/deleted)
├── hash.ts      — xxhash 快速文件指纹
├── language.ts  — 扩展名→语言映射
└── index.ts     — scan() 编排，ProgressCallback + 文件锁 (10min timeout)
```

### Language Runtime 插件系统

`src/chunking/runtime/` 实现可插拔的 Tree-sitter 语言解析架构：

- **LanguageRuntime** (`LanguageRuntime.ts`): 接口定义 — `id`, `languages`, `canParse()`, `createParser()`
- **RuntimeRegistry** (`RuntimeRegistry.ts`): 语言→Runtime 注册表，支持索引查询和遍历回退
- **PluginLoader** (`PluginLoader.ts`): 动态 `import()` npm 插件包，约定 `createRuntime()` 导出。默认候选为 `TypeScript`、`Kotlin`、`Java`、`Rust` 的单语言插件包，加载失败仅 warn 不抛异常
- **BuiltinRuntimeTs25** (`BuiltinRuntimeTs25.ts`): 内置 tree-sitter 运行时，覆盖 JS/Python/Go

### GraphExpander — E1/E2/E3 扩展

`src/search/GraphExpander.ts` 对 rerank 后的 seed chunks 做三级上下文扩展：

- **E1 邻居扩展**：同文件前后相邻 chunks，`neighborHops` 控制跳数
- **E2 面包屑补全**：同 breadcrumb 前缀的其他 chunks，`breadcrumbExpandLimit` 限制数量
- **E3 Import 解析**：通过 resolvers 解析依赖关系，`importFilesPerSeed` 控制跨文件抓取

每种扩展类型有独立 score 衰减系数（`decayNeighbor`/`decayBreadcrumb`/`decayImport`），叠加层数受 `decayDepth` 控制。

### Import Resolvers

`src/search/resolvers/` — 各语言独立解析器，通过 `createResolvers()` 工厂创建。支持 TS/JS、Python、Go、Java、Rust、Kotlin、PHP、Ruby、Swift、Dart、C#、C/C++。解析器返回 `ImportRecord[]`，GraphExpander 用 SQLite FTS 反向查找定义位置。

### Smart TopK 截断策略

`src/search/config.ts` 中的 `DEFAULT_CONFIG` 定义多重保护机制，防止低分结果刷屏：

- **Anchor & Floor**：动态阈值 = `max(floor, min(ratioThreshold, deltaThreshold))`，双重下限保护
- **Delta Guard**：`topScore - smartTopScoreDeltaAbs`，防止 Top1 outlier 场景误判
- **Safe Harbor**：前 `smartMinK` 个只检查 floor，保证基本召回
- **Hard Cap**：`smartMaxK` 硬限制，防止 Token 溢出

默认配置值见 `src/search/config.ts` 的 `DEFAULT_CONFIG` 对象（单一真相源，不在此重复）。

### 索引自愈机制

`src/indexer/index.ts` 通过 `vector_index_hash` 对比文件 hash 检测过期 chunks，采用"先插入新版本再删除旧版本"的单调更新策略，避免向量索引出现缺失窗口。`coderecall doctor . --repair` 可修复 chunks_fts 中的孤儿记录。

## Code Conventions

- TypeScript ESM (`"type": "module"`)，所有相对导入带 `.js` 后缀
- tsup 打包，Node.js >= 20 且 < 24（`.node-version` 固定 22），pnpm 包管理
- 核心流程必须有中文注释
- 环境变量通过 `src/config.ts` 统一读取，不直接读 `process.env`
- CI 流水线: `biome check` → `tsc --noEmit` → `build` → `test`
