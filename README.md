# CodeRecall

<p align="center">
  <strong>🧵 为 AI Agent 精心编织的代码库上下文引擎</strong>
</p>

<p align="center">
  <em>Semantic Code Retrieval for AI Agents — Hybrid Search • Graph Expansion • Token-Aware Packing</em>
</p>

> **致谢**：本项目基于 [hsingjui/CodeRecall](https://github.com/hsingjui/CodeRecall) 修改和扩展而来。衷心感谢原作者 [hsingjui](https://github.com/hsingjui) 的开创性工作与开源精神，为 CodeRecall 打下了坚实基础。我们将在此基础上持续演进，为 AI 辅助编码社区提供更完善的代码库上下文检索体验。

---

**CodeRecall** 是一个面向 AI 代码助手的语义检索引擎。它把代码库索引成可检索的语义上下文，并通过混合搜索（向量 + 词法）、上下文扩展和 Token 感知打包，把更完整、更相关的代码片段交给 LLM。

<p align="center">
  <img src="docs/architecture.png" alt="CodeRecall 架构概览" width="800" />
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
npm install -g @alistar.max/coderecall
```

### 默认核心支持

安装主包后，下列语言默认具备 AST 分片能力，无需额外安装语言插件：

- JavaScript（主包内置）
- Python（主包内置）
- Go（主包内置）
- TypeScript（默认核心插件，自动加载）
- Kotlin（默认核心插件，自动加载）
- Java（默认核心插件，自动加载）
- Rust（默认核心插件，自动加载）

> 默认核心插件（TypeScript、Kotlin、Java、Rust）保持独立包边界，避免把更多 grammar 直接并入主包内置 runtime；安装主包时它们会自动加载，用户无需额外操作。

### 按需安装语言包

这些包属于按需语言插件，用来补齐默认核心支持以外语言的 AST 分片能力。**未安装语言插件时，对应语言仍可索引和搜索，但会回退为纯文本分片。**

```bash
# C / C++ /  C#
npm install -g @alistar.max/coderecall-lang-c
npm install -g @alistar.max/coderecall-lang-cpp
npm install -g @alistar.max/coderecall-lang-csharp

# PHP / Ruby  / Swift
npm install -g @alistar.max/coderecall-lang-php
npm install -g @alistar.max/coderecall-lang-ruby
npm install -g @alistar.max/coderecall-lang-swift
```

## ⚙️ 初始化配置

```bash
coderecall init
# 或使用别名
cr init
```

初始化后编辑 `~/.coderecall/.env`，填写 6 个必需变量：

> **API Key 获取**：推荐到 [硅基流动（SiliconFlow）](https://cloud.siliconflow.cn/me/account/ak) 注册账户，完成实名认证 创建免费的 Key 就可以了。用量较大时可认证多个账户，每个账户创建一个Key，利用 `逗号分隔` 实现请求级轮转，避免触发频率限制。

```env
# Embedding API（必需）
EMBEDDINGS_API_KEYS=your-embedding-api-key
EMBEDDINGS_BASE_URL=https://api.siliconflow.cn/v1/embeddings
EMBEDDINGS_MODEL=BAAI/bge-m3

# Reranker API（必需）
RERANK_API_KEYS=your-reranker-api-key
RERANK_BASE_URL=https://api.siliconflow.cn/v1/rerank
RERANK_MODEL=BAAI/bge-reranker-v2-m3
```

其它可选变量（向量维度、索引/限流档位、包含/忽略模式、多 Key 轮转、旧变量兼容等）详见 `docs/developer/developer-guide.md` 的"环境变量配置参考"小节。

## 📖 使用方法

CodeRecall 提供两种使用方式，可根据你的 个人习惯 选择，推荐：Skill方式，更省 Token。

### 方式一：Skill 加载(✊推荐)

1. 将 `skills/coderecall-search/` 目录复制到 用户目录的 `~/.claude/skills/` 或者 `~/.codex/skills`下即可【其他工具类似 skills 目录即可】**：

2. [可选] 在项目 或者 全局 CLAUDE.md 或者 AGENTS.md 上加一句类似的引导提示词：
```
coderecall-search 是一个 通过 自然语言定位代码 的优先工具，用在：需要理解代码上下文、探索性搜索、或自然语言定位代码的场景

**✅ 适用场景**：

- 探索性搜索（不确定代码在哪个文件/目录）
- 用自然语言描述要找的逻辑（如"XX核心流程"、"XX事件处理"）
- 需要跨文件追踪调用链

**❌ 不适用场景**：
- 已知精确文件路径，直接读取即可
- 简单的文本匹配搜索（用 grep/ripgrep 更快）
```

### 方式二：MCP 集成(不推荐)

> ⚠️ **已知限制**（计划 0.2.0 之前修复）：MCP 模式下为长驻进程，其 VectorStore/Indexer 按 `projectId` 缓存的资源无容量上限。若同一 MCP 进程持续服务多个不同仓库，缓存会随项目数单调增长，可能导致连接数和内存占用不可预测。详见 `docs/developer/cache-and-lock-refactor-design-2026-06-02.md`。
>
> 当前更推荐使用 **CLI 模式**（每次调用独立短生命周期进程，不存在此问题）。

在 MCP 客户端（Claude、Codex、OpenCode 等）中配置 CodeRecall 作为 MCP Server，获得 `codebase-retrieval` 工具的完整检索能力。

**Claude / OpenCode 配置：**

```json
{
  "mcpServers": {
    "@alistar.max/coderecall": {
      "command": "coderecall",
      "args": ["mcp"]
    }
  }
}
```

**Codex CLI 配置**（`~/.codex/config.toml`）：

```toml
[mcp_servers."@alistar.max/coderecall"]
type = "stdio"
command = "coderecall"
args = ["mcp"]
startup_timeout_sec = 20
tool_timeout_sec = 30
```

无论走 CLI 的 `coderecall search` 还是 MCP 的 `codebase-retrieval`，两者共用同一检索入口，每次调用都会先执行自动索引检查：首次使用自动完整索引，后续自动增量索引。


## 🖥️ CLI 使用

### 1) 查看版本

```bash
coderecall --version
cr --version
```

### 2) 初始化配置

```bash
coderecall init
```

该命令会创建 `~/.coderecall/.env`。如果文件已存在，不会覆盖现有配置。

### 3) 索引代码库

```bash
# 索引当前目录
coderecall index .

# 强制重建当前目录索引
coderecall index . --force

# 索引指定项目
coderecall index /path/to/your/project --force
```

首次接入一个项目时，可直接执行 `coderecall search`，入口会自动触发首次全量索引。如果你想在终端里直观观察 Embedding 进度、429 限流和配置错误，也可以先手动跑一次 `--force`。

### 4) 本地搜索

```bash
coderecall search \
  --information-request "登录鉴权流程在哪里实现" \
  --technical-terms "AuthService,login,token"
```

`--information-request` 是必填的语义意图；`--technical-terms` 是可选的精确术语（逗号分隔）；`--repo-path` 可指定目标仓库（默认当前目录）。

### 5) 索引一致性检查

```bash
coderecall doctor /path/to/your/project
coderecall doctor /path/to/your/project --repair
```

`doctor` 用于检查向量索引和 FTS 索引是否一致。`--repair` 会删除 FTS 中没有对应向量记录的孤儿数据。

> `coderecall feedback`（检索反馈摘要）与 `coderecall tune`（离线调参）偏维护者/评测场景，详见 `docs/developer/developer-guide.md`。

## ✅ 测试流程

### 安装后冒烟

```bash
# 1) 确认 CLI 可执行
coderecall --version

# 2) 初始化并配置 API
coderecall init

# 3) [可选] 在目标仓库手动跑一次索引，便于直接在终端观察进度和限流
#    可跳过：下一步 search 会自动触发首次全量索引
cd /path/to/your/project
coderecall index . --force

# 4) 执行一次检索
coderecall search \
  --information-request "插件默认加载顺序在哪里定义" \
  --technical-terms "DEFAULT_PLUGIN_CANDIDATES,PluginLoader" \
  | tee /tmp/coderecall-smoke.txt

# 5) 校验结果是否命中预期术语
rg "PluginLoader|DEFAULT_PLUGIN_CANDIDATES" /tmp/coderecall-smoke.txt
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

CodeRecall 当前采用“主包内置 + 默认核心插件 + 按需插件”三层能力模型：

- 主包内置 AST：JavaScript、Python、Go
- 默认核心插件 AST：TypeScript、Kotlin、Java、Rust
- 按需语言插件 AST：C#、C++、Ruby、C、PHP、Swift
- 未安装按需语言插件：自动回退为纯文本分片，仍可索引、检索和返回上下文

| 语言 | 默认支持层级 | 插件包 | Import 解析 | 扩展名 |
|------|--------------|------------|-------------|--------|
| JavaScript | 主包内置 | 内置 | ✅ | `.js`, `.jsx`, `.mjs` |
| Python | 主包内置 | 内置 | ✅ | `.py` |
| Go | 主包内置 | 内置 | ✅ | `.go` |
| TypeScript | 默认核心插件 | `@alistar.max/coderecall-lang-typescript` | ✅ | `.ts`, `.tsx` |
| Kotlin | 默认核心插件 | `@alistar.max/coderecall-lang-kotlin` | ✅ | `.kt` |
| Java | 默认核心插件 | `@alistar.max/coderecall-lang-java` | ✅ | `.java` |
| Rust | 默认核心插件 | `@alistar.max/coderecall-lang-rust` | ✅ | `.rs` |
| C# | 按需插件 | `@alistar.max/coderecall-lang-csharp` | ✅ | `.cs`, `.csx` |
| C++ | 按需插件 | `@alistar.max/coderecall-lang-cpp` | ✅ | `.cpp`, `.cc`, `.cxx`, `.hpp` |
| Ruby | 按需插件 | `@alistar.max/coderecall-lang-ruby` | ✅ | `.rb` |
| C | 按需插件 | `@alistar.max/coderecall-lang-c` | ✅ | `.c`, `.h` |
| PHP | 按需插件 | `@alistar.max/coderecall-lang-php` | ✅ | `.php` |
| Swift | 按需插件 | `@alistar.max/coderecall-lang-swift` | ✅ | `.swift` |
| Dart | 纯文本回退 | 当前无语言包 | ✅ | `.dart` |

C# Import 解析支持 `using`、`using static`、`global using`、别名导入，并兼容 `global::` 与 `@` 标识符写法。

## ⚙️ 配置参考

仅需填写 Embedding / Reranker 各 3 个必需变量（见"初始化配置"小节）。其它可选变量、旧变量兼容、高级限流覆盖等详见 `docs/developer/developer-guide.md` 的"环境变量配置参考"小节。

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

日志文件位于 `~/.coderecall/logs/app.YYYY-MM-DD.log`。

```bash
LOG_LEVEL=debug coderecall search --information-request "..."
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
