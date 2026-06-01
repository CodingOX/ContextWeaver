# Language Plugin Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除 `lang-ts21` / `lang-ts22` 历史兼容包，并把 `TypeScript`、`Kotlin`、`Java`、`Rust` 提升为主包装上即自动可用的默认核心支持，同时完成测试、文档和发布链收口。

**Architecture:** 保持 builtin runtime 只承载 `JavaScript`、`Python`、`Go`，不直接并入更多 grammar。通过 `PluginLoader` 的默认候选列表提升 `lang-typescript`、`lang-kotlin`、`lang-java`、`lang-rust`，让用户侧体验变成“安装主包即可用”；同时彻底删除 `lang-ts21` / `lang-ts22` 及其测试、文档、发布步骤，避免 legacy 继续泄漏到新用户入口。

**Tech Stack:** TypeScript ESM, pnpm workspace, tree-sitter runtimes, Node.js test runner, GitHub Actions

---

## File Structure

本次实施涉及的文件边界如下：

- 修改 `PluginLoader.ts`
  - 职责：收口默认插件候选，删除 legacy 候选常量，切换到新的默认核心支持集合
- 修改 `ParserPool.ts`
  - 职责：只消费新的默认插件候选，保持初始化逻辑不变
- 删除 `packages/lang-ts21/*`
  - 职责：移除历史兼容包源码与发布元数据
- 删除 `packages/lang-ts22/*`
  - 职责：移除历史兼容包源码与发布元数据
- 修改 `package.json`
  - 职责：从测试命令里删除 legacy 包测试入口，必要时补充新的默认候选覆盖测试
- 修改 `plugin-loader.test.ts`
  - 职责：验证新的默认核心插件集合，不再引用 legacy 常量
- 删除 `lang-ts21-plugin.test.ts`
  - 职责：移除 legacy 包单测
- 删除 `lang-ts22-plugin.test.ts`
  - 职责：移除 legacy 包单测
- 修改 `workspace-packages.test.ts`
  - 职责：更新 workspace 包清单，不再要求 `lang-ts21` / `lang-ts22`
- 修改 `docs-guard.test.ts`
  - 职责：README 断言切换到“默认核心支持”文案，不再要求 legacy 安装命令
- 修改 `README.md`
  - 职责：改成 `builtin / 默认核心支持 / 按需插件` 三层入口
- 修改 `.github/workflows/release.yml`
  - 职责：移除 legacy 包发布步骤，更新发布说明文案
- 修改 `local-manual-release.md`
  - 职责：移除兼容包发布顺序与 npm 验证步骤
- 修改 `developer-guide.md`
  - 职责：同步发布顺序和维护口径
- 视需要修改 `lang-all/package.json` 与 `lang-all/index.ts`
  - 职责：根据最终决定保留或降级 `lang-all` 文案，不改变其聚合实现

---

### Task 1: 收口默认插件候选到核心四语言

**Files:**
- Modify: `PluginLoader.ts`
- Modify: `ParserPool.ts`
- Test: `plugin-loader.test.ts`

- [ ] **Step 1: 先写/改默认候选测试，表达新的核心集合**

在 `plugin-loader.test.ts` 中把“默认插件候选应仅包含默认收敛插件”改成直接断言四个核心插件：

```ts
assert.deepEqual(DEFAULT_PLUGIN_CANDIDATES, [
  '@alistar.max/contextweaver-lang-typescript',
  '@alistar.max/contextweaver-lang-kotlin',
  '@alistar.max/contextweaver-lang-java',
  '@alistar.max/contextweaver-lang-rust',
]);
```

并删除对 `CORE_PLUGIN_CANDIDATES`、`LEGACY_PLUGIN_CANDIDATES` 的断言依赖。

- [ ] **Step 2: 运行单测，确认当前实现失败**

Run:

```bash
tsx tests/runtime/plugin-loader.test.ts
```

Expected:

```text
FAIL
AssertionError: expected DEFAULT_PLUGIN_CANDIDATES to match new core plugin list
```

- [ ] **Step 3: 最小修改 `PluginLoader.ts`**

将候选常量收口成单一默认集合，删掉 legacy 概念：

```ts
export const DEFAULT_PLUGIN_CANDIDATES = [
  '@alistar.max/contextweaver-lang-typescript',
  '@alistar.max/contextweaver-lang-kotlin',
  '@alistar.max/contextweaver-lang-java',
  '@alistar.max/contextweaver-lang-rust',
] as const;
```

并删除：

```ts
export const CORE_PLUGIN_CANDIDATES = ...
export const LEGACY_PLUGIN_CANDIDATES = ...
```

`discoverPluginPackages(...)` 默认参数保持：

```ts
candidates: readonly string[] = DEFAULT_PLUGIN_CANDIDATES
```

- [ ] **Step 4: 检查 `ParserPool.ts` 不需要额外逻辑改动**

确认 `ParserPool.ts` 仍然只通过：

```ts
const pluginRuntimes = await discoverPluginPackages(undefined, {
  suppressMissingModuleError: true,
});
```

拿默认候选集合，不需要补额外语言分支。

- [ ] **Step 5: 运行测试确认通过**

Run:

```bash
tsx tests/runtime/plugin-loader.test.ts
```

Expected:

```text
PASS
```

- [ ] **Step 6: Commit**

```bash
git add src/chunking/runtime/PluginLoader.ts src/chunking/ParserPool.ts tests/runtime/plugin-loader.test.ts
git commit -m "refactor: promote default core language plugins"
```

---

### Task 2: 删除 legacy 包与对应测试入口

**Files:**
- Delete: `packages/lang-ts21/package.json`
- Delete: `packages/lang-ts21/src/index.ts`
- Delete: `packages/lang-ts21/tsconfig.json`
- Delete: `packages/lang-ts22/package.json`
- Delete: `packages/lang-ts22/src/index.ts`
- Delete: `packages/lang-ts22/tsconfig.json`
- Delete: `lang-ts21-plugin.test.ts`
- Delete: `lang-ts22-plugin.test.ts`
- Modify: `package.json`
- Modify: `workspace-packages.test.ts`

- [ ] **Step 1: 先改 workspace/test 断言，表达 legacy 已移除**

在 `workspace-packages.test.ts` 的包清单里删除：

```ts
{ dir: 'lang-ts21', name: '@alistar.max/contextweaver-lang-ts21' },
{ dir: 'lang-ts22', name: '@alistar.max/contextweaver-lang-ts22' },
```

在根 `package.json` 的 `test` 脚本里删除：

```text
tsx tests/runtime/lang-ts21-plugin.test.ts
tsx tests/runtime/lang-ts22-plugin.test.ts
```

- [ ] **Step 2: 运行局部测试，确认当前会因为文件仍存在/断言仍旧不匹配而暴露差异**

Run:

```bash
tsx tests/runtime/workspace-packages.test.ts
```

Expected:

```text
FAIL or mismatch while package list and workspace contents are not yet aligned
```

- [ ] **Step 3: 删除 legacy 包源码与测试文件**

删除目录与文件：

```text
packages/lang-ts21
packages/lang-ts22
tests/runtime/lang-ts21-plugin.test.ts
tests/runtime/lang-ts22-plugin.test.ts
```

注意：用 `apply_patch` 删除文件，不使用破坏性 shell 命令。

- [ ] **Step 4: 运行局部测试确认通过**

Run:

```bash
tsx tests/runtime/workspace-packages.test.ts
pnpm test:runtime
```

Expected:

```text
PASS
```

- [ ] **Step 5: Commit**

```bash
git add package.json tests/runtime/workspace-packages.test.ts
git add -u packages/lang-ts21 packages/lang-ts22 tests/runtime/lang-ts21-plugin.test.ts tests/runtime/lang-ts22-plugin.test.ts
git commit -m "refactor: remove legacy tree-sitter compatibility packages"
```

---

### Task 3: README 与 docs guard 切换到三层支持模型

**Files:**
- Modify: `README.md`
- Modify: `docs-guard.test.ts`

- [ ] **Step 1: 先改 README 约束测试**

把 `docs-guard.test.ts` 从检查 legacy 包命令改成检查新的文案边界，例如：

```ts
assert.match(readme, /主包默认具备 JavaScript、Python、Go/);
assert.match(readme, /默认核心支持.*TypeScript.*Kotlin.*Java.*Rust/s);
assert.doesNotMatch(readme, /contextweaver-lang-ts21/);
assert.doesNotMatch(readme, /contextweaver-lang-ts22/);
```

并根据最终决策决定是否继续断言 `lang-all`。

- [ ] **Step 2: 运行文档守卫测试，确认当前 README 失败**

Run:

```bash
tsx tests/runtime/docs-guard.test.ts
```

Expected:

```text
FAIL
```

- [ ] **Step 3: 改写 README 安装章节**

将安装说明收口成三层：

```md
主包默认具备 JavaScript、Python、Go 的 AST 分片能力。

默认核心支持：
- TypeScript
- Kotlin
- Java
- Rust

按需扩展：
- C / C++ / C#
- PHP / Ruby / Swift
```

并删除：

```md
兼容包仍保留给历史安装链路...
npm install -g @alistar.max/contextweaver-lang-ts21
npm install -g @alistar.max/contextweaver-lang-ts22
```

如果保留 `lang-all`，只能保留为补充说明，不能再写成推荐路径。

- [ ] **Step 4: 运行文档守卫测试确认通过**

Run:

```bash
tsx tests/runtime/docs-guard.test.ts
```

Expected:

```text
PASS
```

- [ ] **Step 5: Commit**

```bash
git add README.md tests/runtime/docs-guard.test.ts
git commit -m "docs: document builtin core and optional language support"
```

---

### Task 4: 发布链与维护文档删除 legacy 包

**Files:**
- Modify: `release.yml`
- Modify: `local-manual-release.md`
- Modify: `developer-guide.md`
- Optional Modify: release note / migration docs that still mention `lang-ts21` or `lang-ts22`

- [ ] **Step 1: 先搜索剩余 legacy 引用并列出清单**

Run:

```bash
rg -n "lang-ts21|lang-ts22" .github docs README.md tests src packages
```

Expected:

```text
only release/developer/migration files and spec/plan files remain before edits
```

- [ ] **Step 2: 修改 GitHub Actions 发布矩阵**

在 `release.yml` 中删除：

```text
['@alistar.max/contextweaver-lang-ts21', 'packages/lang-ts21/package.json']
['@alistar.max/contextweaver-lang-ts22', 'packages/lang-ts22/package.json']
publish_if_needed "@alistar.max/contextweaver-lang-ts21" "packages/lang-ts21"
publish_if_needed "@alistar.max/contextweaver-lang-ts22" "packages/lang-ts22"
```

并把发布说明文案改成：

```text
默认核心支持：TypeScript / Kotlin / Java / Rust
按需插件：C / C++ / C# / PHP / Ruby / Swift
```

- [ ] **Step 3: 修改维护文档**

在 `local-manual-release.md`、`developer-guide.md` 中删除兼容插件分组和发布顺序描述，统一成：

```md
发布顺序：单语言包 -> （可选）lang-all -> 主包
```

如果决定保留 `lang-all`，就在文档中标注“补充型聚合包”；如果决定删除 `lang-all`，在同一任务里一并删掉相关文案。

- [ ] **Step 4: 运行一次剩余引用检查**

Run:

```bash
rg -n "lang-ts21|lang-ts22" .github docs README.md tests src packages
```

Expected:

```text
only spec/plan historical documents may still mention them
```

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release.yml docs/release/local-manual-release.md docs/developer/developer-guide.md
git commit -m "chore: remove legacy language packages from release workflow"
```

---

### Task 5: 全量回归并确认 breaking change 说明

**Files:**
- Modify: any release note or changelog file chosen for this release
- Verify: `package.json`, `README.md`, `PluginLoader.ts`, workflow/docs updates

- [ ] **Step 1: 补一段 breaking change 发布说明**

在本次选定的 release note / changelog 文档中补入明确迁移说明：

```md
Breaking change:
- removed @alistar.max/contextweaver-lang-ts21
- removed @alistar.max/contextweaver-lang-ts22

Replacement:
- TypeScript -> @alistar.max/contextweaver-lang-typescript
- Kotlin -> @alistar.max/contextweaver-lang-kotlin
- Java -> @alistar.max/contextweaver-lang-java
- Rust -> @alistar.max/contextweaver-lang-rust
```

- [ ] **Step 2: 跑关键测试切片**

Run:

```bash
tsx tests/runtime/plugin-loader.test.ts
tsx tests/runtime/workspace-packages.test.ts
tsx tests/runtime/docs-guard.test.ts
tsx tests/runtime/parser-pool.test.ts
```

Expected:

```text
all PASS
```

- [ ] **Step 3: 跑一次完整测试**

Run:

```bash
pnpm test
```

Expected:

```text
PASS
```

- [ ] **Step 4: 跑构建与类型检查**

Run:

```bash
pnpm tsc --noEmit
pnpm build
```

Expected:

```text
PASS
```

- [ ] **Step 5: Commit**

```bash
git add package.json README.md src tests .github docs
git commit -m "feat: simplify default language plugin support model"
```

---

## Self-Review

- Spec coverage:
  - 删除 `lang-ts21` / `lang-ts22`：Task 2 / Task 4 / Task 5
  - 默认核心支持提升为 TS/Kotlin/Java/Rust：Task 1 / Task 3
  - README 三层模型：Task 3
  - 发布与维护文档收口：Task 4
  - breaking change 说明：Task 5
- Placeholder scan:
  - 无 `TBD` / `TODO` / “后续再补” 类占位词
- Type consistency:
  - 默认核心插件统一使用 `TypeScript`、`Kotlin`、`Java`、`Rust`
  - legacy 包统一使用 `lang-ts21`、`lang-ts22`

