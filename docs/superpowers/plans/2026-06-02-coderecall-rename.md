# CodeRecall 项目改名 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将项目中所有 CodeRecall 相关命名统一改为 CodeRecall（包名 `@alistar.max/coderecall`，命令 `coderecall`/`cr`，配置目录 `~/.coderecall/`）

**Architecture:** 机械性批量替换操作，按优先级分 6 组，每组对应一次 commit。使用 ripgrep 批量替换 + 手动检查特殊边界。全部改完后 `pnpm install` 重建 lockfile，`pnpm build && pnpm test` 验证。

**Tech Stack:** ripgrep (rg), sed, git mv

---

### Task 1: P0 — 核心身份改名（src 源码 + 根 package.json）

**Files:**
- Modify: `package.json`
- Modify: `src/index.ts`
- Modify: `src/config.ts`
- Modify: `src/db/index.ts`
- Modify: `src/vectorStore/index.ts`
- Modify: `src/utils/lock.ts`
- Modify: `src/utils/logger.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/mcp/tools/codebaseRetrieval.ts`
- Modify: `src/scanner/filter.ts`

- [ ] **Step 1: 备份验证 —— 确认当前状态可构建**

```bash
pnpm build 2>&1 | tail -5
```
Expected: 构建成功，无错误。

- [ ] **Step 2: 批量替换 `~/.coderecall` → `~/.coderecall`（src 目录，不含 tests）**

所有 `src/` 下的 `.coderecall` 路径引用（config、db、vectorStore、lock、logger、mcp）：

```bash
rg -l '\.coderecall' src/ | while read f; do
  sed -i '' "s/\.coderecall/.coderecall/g" "$f"
done
```

注意：`sed -i ''` 是 macOS 语法，Linux 上改为 `sed -i`。

- [ ] **Step 3: 替换 `.coderecallinclude` → `.coderecallinclude`**

```bash
rg -l '\.coderecallinclude' src/ | while read f; do
  sed -i '' "s/\.coderecallinclude/.coderecallinclude/g" "$f"
done
```

- [ ] **Step 4: 替换 `coderecall` 命令名 + `CodeRecall` 产品名（src 源码）**

```bash
# 替换 cac('coderecall') 为 cac('coderecall')
rg -l "cac('coderecall')" src/ | while read f; do
  sed -i '' "s/cac('coderecall')/cac('coderecall')/g" "$f"
done

# 替换 SERVER_NAME = 'coderecall' 为 'coderecall'
rg -l "SERVER_NAME = 'coderecall'" src/ | while read f; do
  sed -i '' "s/SERVER_NAME = 'coderecall'/SERVER_NAME = 'coderecall'/g" "$f"
done

# 替换 logger name: 'coderecall' → 'coderecall'
rg -l "name: 'coderecall'" src/ | while read f; do
  sed -i '' "s/name: 'coderecall'/name: 'coderecall'/g" "$f"
done

# 替换注释中的 CodeRecall → CodeRecall
rg -l 'CodeRecall' src/ | while read f; do
  sed -i '' "s/CodeRecall/CodeRecall/g" "$f"
done
```

- [ ] **Step 5: 手动更新 `src/index.ts` 中 help 文本的命令引用**

读取 `src/index.ts`，确认以下变更：
- `'初始化 CodeRecall 配置'` → `'初始化 CodeRecall 配置'`（第 32 行）
- `'开始初始化 CodeRecall...'` → `'开始初始化 CodeRecall...'`（第 36 行）
- `'coderecall index --force'` → `'coderecall index --force'`（第 343 行）

- [ ] **Step 6: 手动更新 `src/config.ts` 中的注释**

读取 `src/config.ts`，确认：
- `通过命令行参数判断（coderecall mcp）` → `（coderecall mcp）`
- `# CodeRecall 示例环境变量配置文件` → `# CodeRecall 示例环境变量配置文件`

- [ ] **Step 7: 手动更新 `src/mcp/server.ts` 中文件头注释**

读取 `src/mcp/server.ts` 第 2 行：
- `* CodeRecall MCP Server` → `* CodeRecall MCP Server`

- [ ] **Step 8: 手动更新 `src/mcp/tools/codebaseRetrieval.ts` 中的用户提示文本**

读取文件，确认：
- `CodeRecall 需要配置 Embedding API` → `CodeRecall 需要配置 Embedding API`
- `const configPath = '~/.coderecall/.env'` → `'~/.coderecall/.env'`

- [ ] **Step 9: 更新 `package.json`**

```bash
# 包名
sed -i '' 's/"@alistar\.max\/coderecall"/"@alistar.max\/coderecall"/' package.json

# bin 命令名: "coderecall" → "coderecall"
sed -i '' 's/"coderecall": "dist\/index.js"/"coderecall": "dist\/index.js"/' package.json

# bin 别名: "cw" → "cr"
sed -i '' 's/"cw": "dist\/index.js"/"cr": "dist\/index.js"/' package.json

# GitHub URL
sed -i '' 's/CodingOX\/CodeRecall/CodingOX\/CodeRecall/g' package.json
```

- [ ] **Step 10: 构建验证**

```bash
pnpm build 2>&1 | tail -10
```
Expected: 构建成功。

- [ ] **Step 11: Commit P0**

```bash
git add package.json src/
git commit -m "refactor: rename core identity from CodeRecall to CodeRecall

- package name: @alistar.max/coderecall → @alistar.max/coderecall
- CLI command: coderecall → coderecall (alias: cw → cr)
- config directory: ~/.coderecall → ~/.coderecall
- include file: .coderecallinclude → .coderecallinclude
- MCP server name: coderecall → coderecall"
```

---

### Task 2: P1 — 插件生态改名

**Files:**
- Modify: `src/chunking/runtime/PluginLoader.ts`
- Modify: `packages/lang-*/package.json` (11 files)
- Modify: `packages/lang-all/package.json`
- Modify: `packages/lang-all/src/index.ts`

- [ ] **Step 1: 替换 PluginLoader 中的默认插件包名**

```bash
sed -i '' 's/@alistar\.max\/coderecall-lang-/@alistar.max\/coderecall-lang-/g' src/chunking/runtime/PluginLoader.ts
```

- [ ] **Step 2: 替换所有插件 package.json 中的包名和 URL**

```bash
for f in packages/lang-*/package.json; do
  sed -i '' 's/@alistar\.max\/coderecall-lang-/@alistar.max\/coderecall-lang-/g' "$f"
  sed -i '' 's/CodingOX\/CodeRecall/CodingOX\/CodeRecall/g' "$f"
done
```

- [ ] **Step 3: 替换 lang-all/package.json 中 dependencies 的包名**

`packages/lang-all/package.json` 的 `dependencies` 字段中有 10 个 `@alistar.max/coderecall-lang-*` 引用：

```bash
sed -i '' 's/@alistar\.max\/coderecall-lang-/@alistar.max\/coderecall-lang-/g' packages/lang-all/package.json
sed -i '' 's/CodingOX\/CodeRecall/CodingOX\/CodeRecall/g' packages/lang-all/package.json
```

- [ ] **Step 4: 替换 lang-all/src/index.ts 中的 import 语句**

```bash
sed -i '' "s/@alistar\.max\/coderecall-lang-/@alistar.max\/coderecall-lang-/g" packages/lang-all/src/index.ts
```

- [ ] **Step 5: 构建验证**

```bash
pnpm build 2>&1 | tail -10
```
Expected: 构建成功，插件包正常编译。

- [ ] **Step 6: Commit P1**

```bash
git add src/chunking/runtime/PluginLoader.ts packages/
git commit -m "refactor: rename all plugin packages to coderecall-lang-*

- @alistar.max/coderecall-lang-* → @alistar.max/coderecall-lang-*
- PluginLoader default candidates updated
- lang-all umbrella package imports and dependencies updated"
```

---

### Task 3: P2 — CI/CD 与脚本改名

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `.github/workflows/smoke-install.yml`
- Modify: `scripts/check-node-version.js`
- Modify: `scripts/publish-plugins.sh`

- [ ] **Step 1: 替换 release.yml 中所有包名**

```bash
sed -i '' "s/@alistar\.max\/coderecall/@alistar.max\/coderecall/g" .github/workflows/release.yml
sed -i '' 's/CodingOX\/CodeRecall/CodingOX\/CodeRecall/g' .github/workflows/release.yml
sed -i '' 's/CodeRecall/CodeRecall/g' .github/workflows/release.yml
```

- [ ] **Step 2: 替换 smoke-install.yml 中的命令名**

```bash
sed -i '' 's/coderecall/coderecall/g' .github/workflows/smoke-install.yml
```

- [ ] **Step 3: 替换 check-node-version.js 中的环境变量和日志前缀**

```bash
sed -i '' 's/CONTEXTWEAVER_NODE_VERSION_OVERRIDE/CODERECALL_NODE_VERSION_OVERRIDE/g' scripts/check-node-version.js
sed -i '' 's/\[CodeRecall\]/[CodeRecall]/g' scripts/check-node-version.js
```

- [ ] **Step 4: 替换 publish-plugins.sh 中的注释**

```bash
sed -i '' 's/CodeRecall/CodeRecall/g' scripts/publish-plugins.sh
```

- [ ] **Step 5: Commit P2**

```bash
git add .github/ scripts/
git commit -m "refactor: update CI/CD workflows and scripts for CodeRecall rename

- Release workflow package names updated
- Smoke test command changed to coderecall
- CONTEXTWEAVER_NODE_VERSION_OVERRIDE → CODERECALL_NODE_VERSION_OVERRIDE
- Script log prefixes updated"
```

---

### Task 4: P3 — 测试文件改名

**Files:**
- Modify: `tests/runtime/install-guard.test.ts`
- Modify: `tests/runtime/plugin-loader.test.ts`
- Modify: `tests/runtime/workspace-packages.test.ts`
- Modify: `tests/runtime/docs-guard.test.ts`
- Modify: `tests/runtime/config-multi-key.test.ts`
- Modify: `tests/runtime/cli-behavior.test.ts`
- Modify: `tests/runtime/context-packer.test.ts`
- Modify: `tests/runtime/index-healing-convergence.test.ts`
- Modify: `tests/runtime/lock-regression.test.ts`
- Modify: `tests/runtime/fallback-split.test.ts`
- Modify: `tests/runtime/scanner-coverage-expansion.test.ts`
- Modify: `tests/mcp-e2e-smoke.ts`

- [ ] **Step 1: 替换所有测试文件中 `.coderecall` → `.coderecall`**

```bash
rg -l '\.coderecall' tests/ | while read f; do
  sed -i '' "s/\.coderecall/.coderecall/g" "$f"
done
```

- [ ] **Step 2: 替换测试文件中 `CONTEXTWEAVER_NODE_VERSION_OVERRIDE` → `CODERECALL_NODE_VERSION_OVERRIDE`**

```bash
sed -i '' 's/CONTEXTWEAVER_NODE_VERSION_OVERRIDE/CODERECALL_NODE_VERSION_OVERRIDE/g' tests/runtime/install-guard.test.ts
```

- [ ] **Step 3: 替换测试文件中插件包名**

```bash
sed -i '' "s/@alistar\.max\/coderecall-lang-/@alistar.max\/coderecall-lang-/g" tests/runtime/plugin-loader.test.ts
sed -i '' "s/@alistar\.max\/coderecall-lang-/@alistar.max\/coderecall-lang-/g" tests/runtime/workspace-packages.test.ts
sed -i '' "s/@alistar\.max\\/coderecall-lang-/@alistar.max\\/coderecall-lang-/g" tests/runtime/docs-guard.test.ts
```

- [ ] **Step 4: 替换测试文件中的 temp dir 前缀 `cw-` → `cr-`**

```bash
sed -i '' "s/'cw-/'cr-/g" tests/runtime/plugin-loader.test.ts
sed -i '' "s/'coderecall-/'coderecall-/g" tests/runtime/cli-behavior.test.ts
sed -i '' "s/'coderecall-/'coderecall-/g" tests/runtime/config-multi-key.test.ts
sed -i '' "s/'coderecall-/'coderecall-/g" tests/runtime/fallback-split.test.ts
sed -i '' "s/'coderecall-/'coderecall-/g" tests/runtime/scanner-coverage-expansion.test.ts
sed -i '' "s/'coderecall-/'coderecall-/g" tests/mcp-e2e-smoke.ts
```

- [ ] **Step 5: 替换 scanner-coverage-expansion.test.ts 中的 `.coderecallinclude`**

```bash
sed -i '' "s/\.coderecallinclude/.coderecallinclude/g" tests/runtime/scanner-coverage-expansion.test.ts
```

- [ ] **Step 6: 替换 config-multi-key.test.ts 中 spawn 命令**

读取 `tests/runtime/config-multi-key.test.ts` 确认：
- `['node', 'coderecall', ...argv]` → `['node', 'coderecall', ...argv]`

```bash
# 只替换 spawn 命令中的字符串，不是所有 coderecall
sed -i '' "s/\['node', 'coderecall'\]/['node', 'coderecall'\]/g" tests/runtime/config-multi-key.test.ts
```

- [ ] **Step 7: 运行测试验证**

```bash
pnpm test 2>&1 | tail -30
```
Expected: 所有测试通过。

- [ ] **Step 8: Commit P3**

```bash
git add tests/
git commit -m "refactor: update all test files for CodeRecall rename

- Config paths, package names, env var names updated
- Temp directory prefixes changed to coderecall/cr
- Spawn commands use coderecall instead of coderecall"
```

---

### Task 5: P4 — 文档与 Skill 改名

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `AGENTS.md`
- Rename: `skills/coderecall-search/` → `skills/coderecall-search/`
- Modify: `skills/coderecall-search/SKILL.md`

- [ ] **Step 1: 替换 README.md 中所有引用**

```bash
sed -i '' "s/@alistar\.max\/coderecall/@alistar.max\/coderecall/g" README.md
sed -i '' 's/CodingOX\/CodeRecall/CodingOX\/CodeRecall/g' README.md
sed -i '' 's/coderecall/coderecall/g' README.md
sed -i '' 's/cw /cr /g' README.md
sed -i '' 's/CodeRecall/CodeRecall/g' README.md
sed -i '' "s/\.coderecall/.coderecall/g" README.md
```

注意：`cw ` 带空格的替换避免误伤其他包含 `cw` 的文本。

- [ ] **Step 2: 替换 CLAUDE.md 和 AGENTS.md**

```bash
for f in CLAUDE.md AGENTS.md; do
  sed -i '' 's/coderecall/coderecall/g' "$f"
  sed -i '' 's/CodeRecall/CodeRecall/g' "$f"
  sed -i '' "s/\.coderecall/.coderecall/g" "$f"
done
```

- [ ] **Step 3: 重命名 skill 目录**

```bash
git mv skills/coderecall-search skills/coderecall-search
```

- [ ] **Step 4: 更新 SKILL.md 内容**

```bash
sed -i '' 's/coderecall/coderecall/g' skills/coderecall-search/SKILL.md
sed -i '' 's/CodeRecall/CodeRecall/g' skills/coderecall-search/SKILL.md
sed -i '' "s/\.coderecall/.coderecall/g" skills/coderecall-search/SKILL.md
sed -i '' "s/coderecall-search/coderecall-search/g" skills/coderecall-search/SKILL.md
```

- [ ] **Step 5: Commit P4**

```bash
git add README.md CLAUDE.md AGENTS.md skills/
git commit -m "docs: update all documentation and skill for CodeRecall rename

- README, CLAUDE.md, AGENTS.md fully updated
- skills/coderecall-search → skills/coderecall-search (directory + content)"
```

---

### Task 6: P5 — 历史文档改名

**Files:**
- Modify: `docs/developer/developer-guide.md`
- Modify: `docs/todo.md`
- Modify: `docs/specs/*.md` (4 files)
- Modify: `docs/plans/*.md` (5 files)
- Modify: `docs/logs/*.md` (8+ files)
- Modify: `docs/release/*.md` (2 files)
- Modify: `docs/superpowers/plans/*.md` (1 file)

- [ ] **Step 1: 批量替换 docs/ 下所有文件**

```bash
rg -l 'coderecall\|CodeRecall\|\.coderecall' docs/ | while read f; do
  sed -i '' 's/@alistar\.max\/coderecall/@alistar.max\/coderecall/g' "$f"
  sed -i '' 's/CodingOX\/CodeRecall/CodingOX\/CodeRecall/g' "$f"
  sed -i '' 's/coderecall/coderecall/g' "$f"
  sed -i '' 's/CodeRecall/CodeRecall/g' "$f"
  sed -i '' "s/\.coderecall/.coderecall/g" "$f"
done
```

- [ ] **Step 2: Commit P5**

```bash
git add docs/
git commit -m "docs: update historical documentation for CodeRecall rename"
```

---

### Task 7: 最终清理与全局验证

- [ ] **Step 1: 检查是否有遗漏的 `coderecall` 引用**

```bash
rg -l 'coderecall' --ignore-case 2>/dev/null | grep -v node_modules | grep -v '.git/' | grep -v pnpm-lock.yaml
```
Expected: 空输出（无遗漏）。

- [ ] **Step 2: 检查是否有遗漏的 `CodeRecall` 引用**

```bash
rg -l 'CodeRecall' 2>/dev/null | grep -v node_modules | grep -v '.git/' | grep -v pnpm-lock.yaml
```
Expected: 空输出（无遗漏）。

- [ ] **Step 3: 检查是否有遗漏的 `\.coderecall` 路径引用**

```bash
rg -l '\.coderecall' 2>/dev/null | grep -v node_modules | grep -v '.git/' | grep -v pnpm-lock.yaml
```
Expected: 空输出（无遗漏）。

- [ ] **Step 4: 重新生成 pnpm-lock.yaml**

```bash
pnpm install --frozen-lockfile 2>&1 || pnpm install 2>&1 | tail -15
```
注意：`--frozen-lockfile` 可能因包名变更而失败，需要 `pnpm install` 重新生成。

- [ ] **Step 5: 完整构建 + 测试**

```bash
pnpm build && pnpm test 2>&1 | tail -20
```
Expected: 构建成功，所有测试通过。

- [ ] **Step 6: Commit 最终清理**

```bash
git add pnpm-lock.yaml
git commit -m "chore: regenerate lockfile after CodeRecall rename"
```

- [ ] **Step 7: 最终扫尾 —— 全局 grep 确认零遗漏**

```bash
echo "=== 检查遗漏 ===" && \
rg -c 'coderecall|CodeRecall|\.coderecall|CONTEXTWEAVER' --ignore-case \
  2>/dev/null | grep -v node_modules | grep -v '.git/' | grep -v pnpm-lock.yaml | grep -v 'docs/superpowers/plans/'
```
Expected: 空输出（docs/superpowers/plans/ 中的本次 plan 文件本身会包含旧名，属于正常情况）。

---

### 执行顺序

```
Task 1 (P0 核心) → Task 2 (P1 插件) → Task 3 (P2 CI/CD) → Task 4 (P3 测试) → Task 5 (P4 文档) → Task 6 (P5 历史) → Task 7 (验证)
```

每组 Task 完成后立即 commit，便于回滚。
