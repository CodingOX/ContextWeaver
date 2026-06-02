# CodeRecall 0.0.8 Release Notes

发布日期：2026-02-10

## ✨ 亮点

- 支持 Node.js 24（`engines.node` 调整为 `>=20 <25`）。
- 主包安装降噪：默认仅携带 `tree-sitter@^0.25` 生态语言（JavaScript / Python / Go）。
- 新增可选语言插件：
  - `@alistar.max/coderecall-lang-ts21`（TypeScript / Kotlin / C# / C++ / Java / Ruby）
  - `@alistar.max/coderecall-lang-ts22`（C / PHP / Rust / Swift）
- 插件运行时动态发现：插件缺失或加载失败不会中断索引流程。

## 🔧 变更详情

### 安装与兼容性

- 去除 Node24 安装拦截脚本，允许 Node24 正常安装与运行。
- 新增 Node24 本地冒烟脚本：`tests/install/node24-smoke.mjs`。
- 新增安装冒烟 CI：覆盖 Node `20/22/24` + `npm/pnpm`。

### 架构与运行时

- 引入语言运行时抽象与注册机制：
  - `LanguageRuntime`
  - `RuntimeRegistry`
  - `PluginLoader`
- `ParserPool` 切换为「内置 runtime + 可选插件 runtime」调度。
- 无 AST 语言运行时时保持纯文本 fallback 行为。

### 文档与发布流程

- README 新增“可选语言插件”章节与安装说明。
- 发布流程更新为“插件优先、主包后发”。
- 补充迁移文档与 0.0.8 发布清单。

## ⚠️ 行为变化（需要关注）

- 主包默认不再内置以下 AST 语法：TypeScript、Kotlin、PHP、Rust、Swift、C/C++、C#、Ruby。
- 如需上述语言的 AST 分片能力，需额外安装对应插件包。
- 未安装插件时，这些语言会退化为纯文本分片（可索引，但语义结构能力降低）。

## ✅ 验证摘要

- `pnpm install --frozen-lockfile`
- `pnpm test`
- `pnpm test:e2e:mcp`
- `pnpm -r build`
- `npm pack --dry-run`
- `npx -y node@24.11.1 tests/install/node24-smoke.mjs`

以上验证在本地均通过。

## ❓ 安装 FAQ

### Q1：Node 24 能安装吗？

可以。当前版本支持 `Node.js >= 20 且 < 25`，包含 Node 24。

### Q2：为什么 `pnpm` 安装后提示原生模块缺失？

`pnpm v10+` 默认会拦截部分依赖构建脚本。请先执行：

```bash
pnpm approve-builds -g
```

并批准 `better-sqlite3`、`tree-sitter` 以及可选插件对应的 `tree-sitter-*`。

### Q3：报 `Could not locate the bindings file` 怎么办？

先重建主包依赖：

```bash
pnpm rebuild -g better-sqlite3 tree-sitter tree-sitter-go tree-sitter-javascript tree-sitter-python
```

如安装了插件，再补充重建插件依赖：

```bash
pnpm rebuild -g tree-sitter-c-sharp tree-sitter-cpp tree-sitter-java tree-sitter-kotlin tree-sitter-ruby tree-sitter-typescript
pnpm rebuild -g tree-sitter-c tree-sitter-php tree-sitter-rust tree-sitter-swift
```

### Q4：不装插件会影响使用吗？

不会阻断索引和搜索；未安装插件时会自动回退纯文本分片。
只是 AST 结构化分片能力会下降。

