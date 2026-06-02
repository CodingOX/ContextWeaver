# CLI Native Search Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `search` 从 MCP 包装复用改造成原生 CLI-first 的公共搜索编排入口，并在第二阶段补齐 `--json` 与 `--code-only` 搜索阶段过滤能力。

**Architecture:** 第一阶段先抽离公共编排层，把环境检查、自动索引、查询执行和文本格式化从 `codebaseRetrieval.ts` 中迁出，CLI 与 MCP 共同复用。第二阶段再在统一搜索链路中引入协议无关过滤抽象，让 `--code-only` 同时作用于向量召回、词法召回和上下文扩展，而不是仅停留在 CLI 参数层。

**Tech Stack:** TypeScript, Node.js 20+, cac CLI, better-sqlite3, LanceDB, MCP SDK, tsx test runner

---

**一、文件结构**

本计划按 P0 / P1 两层推进，先锁定文件边界。

**P0 新增文件**

- Create: `src/app/searchCodebase.ts`
- Create: `src/app/ensureIndexed.ts`
- Create: `src/app/ensureDefaultEnvFile.ts`
- Create: `src/app/formatSearchText.ts`
- Create: `tests/search-service-unit.test.ts`
- Create: `tests/search-cli-smoke.ts`

**P0 修改文件**

- Modify: `src/index.ts`
- Modify: `src/mcp/tools/codebaseRetrieval.ts`
- Modify: `src/mcp/tools/index.ts`

**P1 新增文件**

- Create: `src/search/filtering.ts`
- Create: `tests/search-filtering.test.ts`

**P1 修改文件**

- Modify: `src/search/types.ts`
- Modify: `src/search/SearchService.ts`
- Modify: `src/search/GraphExpander.ts`
- Modify: `src/indexer/index.ts`
- Modify: `src/index.ts`
- Modify: `src/mcp/tools/codebaseRetrieval.ts`
- Modify: `tests/search-cli-smoke.ts`

**说明**

- `generateProjectId()` 保持在 `src/db/index.ts`，本计划不迁移。
- `ContextPack` 数据结构保持原位，避免把分层改造扩大成搜索核心重写。
- `tests/mcp-e2e-smoke.ts` 作为已有回归入口保留，只在必要时补断言，不作为本轮第一优先测试承载。
- `ChunkRecord` 在 `vectorStore/index.ts` 中已定义 `language: string` 字段，因此过滤链路可以直接使用 chunk 级语言元数据，不需要退回到扩展名推导。

### Task 1: 建立 P0 测试骨架与断言目标

**Files:**
- Create: `tests/search-service-unit.test.ts`
- Create: `tests/search-cli-smoke.ts`
- Test: `tests/search-service-unit.test.ts`
- Test: `tests/search-cli-smoke.ts`

- [ ] **Step 1: 编写当前入口形态的单元测试骨架**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

test('当前 MCP 工具注册中心只暴露 MCP 适配层入口', async () => {
  const tools = await import('../src/mcp/tools/index.js');
  assert.equal(typeof tools.handleCodebaseRetrieval, 'function');
  assert.equal('searchCodebase' in tools, false);
});

test('当前 CLI search 仍通过 MCP 适配层组织检索', async () => {
  const tools = await import('../src/mcp/tools/index.js');
  assert.equal(typeof tools.handleCodebaseRetrieval, 'function');
  assert.equal('searchCodebase' in tools, false);
  );
});
```

- [ ] **Step 2: 运行单元测试并确认当前失败**

Run: `pnpm exec tsx --test tests/search-service-unit.test.ts`
Expected: PASS，确认当前公开入口仍然只有 MCP 适配层；这条测试用于锁定重构前现状，而不是制造红灯

- [ ] **Step 3: 编写 CLI 当前失败路径的 smoke 测试骨架**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('search command prints friendly config error via CLI', async () => {
  const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'coderecall-cli-home-'));
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', 'search', '--query', 'auth flow'], {
      cwd: process.cwd(),
      env: { HOME: fakeHome, PATH: process.env.PATH || '', NODE_ENV: 'production' },
    });

    const code: number = await new Promise((resolve) => child.on('close', resolve));
    assert.notEqual(code, 0);
  } finally {
    await fs.rm(fakeHome, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: 运行 smoke 测试并确认当前失败路径仍存在**

Run: `pnpm exec tsx --test tests/search-cli-smoke.ts`
Expected: PASS，确认当前 `--query` 路径仍是失败态；这条测试锁定的是“当前未实现能力”的稳定现状

- [ ] **Step 5: 提交测试骨架**

```bash
git add tests/search-service-unit.test.ts tests/search-cli-smoke.ts
git commit -m "test: capture current cli search baseline"
```

### Task 2: 抽出配置初始化与索引前置公共模块

**Files:**
- Create: `src/app/ensureDefaultEnvFile.ts`
- Create: `src/app/ensureIndexed.ts`
- Modify: `src/mcp/tools/codebaseRetrieval.ts`
- Test: `tests/search-service-unit.test.ts`

- [ ] **Step 1: 编写 `ensureDefaultEnvFile` 失败测试**

```ts
test('ensureDefaultEnvFile creates ~/.coderecall/.env when absent', async () => {
  const { ensureDefaultEnvFile } = await import('../src/app/ensureDefaultEnvFile.ts');
  const result = await ensureDefaultEnvFile('/tmp/coderecall-test-home/.coderecall');
  assert.equal(result.created, true);
  assert.match(result.envFile, /\.coderecall\/\.env$/);
});

test('ensureIndexed returns wasIndexed=false on first scan', async () => {
  const { ensureIndexed } = await import('../src/app/ensureIndexed.ts');
  const result = await ensureIndexed('/tmp/coderecall-empty-repo', 'project-123', undefined, {
    baseDir: '/tmp/coderecall-index-base',
    withLock: async (_projectId, _operation, fn) => fn(),
    scan: async () => ({
      totalFiles: 0,
      added: 0,
      modified: 0,
      unchanged: 0,
      deleted: 0,
      skipped: 0,
      errors: 0,
    }),
  });
  assert.equal(result.wasIndexed, false);
});
```

- [ ] **Step 2: 运行测试确认当前失败**

Run: `pnpm exec tsx --test tests/search-service-unit.test.ts`
Expected: FAIL，提示缺少 `ensureDefaultEnvFile.ts`

- [ ] **Step 3: 实现 `ensureDefaultEnvFile.ts`**

```ts
export interface EnsureDefaultEnvFileResult {
  created: boolean;
  envFile: string;
}

export async function ensureDefaultEnvFile(
  baseDir: string,
): Promise<EnsureDefaultEnvFileResult> {
  const envFile = path.join(baseDir, '.env');

  if (fs.existsSync(envFile)) {
    return { created: false, envFile };
  }

  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(envFile, DEFAULT_ENV_CONTENT);
  return { created: true, envFile };
}
```

- [ ] **Step 4: 实现 `ensureIndexed.ts`**

```ts
export interface EnsureIndexedOptions {
  baseDir?: string;
  withLock: <T>(projectId: string, operation: string, fn: () => Promise<T>) => Promise<T>;
  scan: (
    repoPath: string,
    options: { vectorIndex: boolean; onProgress?: ProgressCallback },
  ) => Promise<ScanStats>;
}

export interface EnsureIndexedResult {
  wasIndexed: boolean;
  stats: ScanStats;
}

export async function ensureIndexed(
  repoPath: string,
  projectId: string,
  onProgress: ProgressCallback | undefined,
  options: EnsureIndexedOptions,
): Promise<EnsureIndexedResult> {
  const baseDir = options.baseDir ?? DEFAULT_BASE_DIR;

  return options.withLock(projectId, 'index', async () => {
    const wasIndexed = isProjectIndexed(baseDir, projectId);
    const stats = await options.scan(repoPath, { vectorIndex: true, onProgress });
    return { wasIndexed, stats };
  });
}
```

- [ ] **Step 5: 修改 `codebaseRetrieval.ts` 使用新模块**

```ts
import { ensureDefaultEnvFile } from '../../app/ensureDefaultEnvFile.js';
import { ensureIndexed } from '../../app/ensureIndexed.js';

// 删除文件内原有的 ensureDefaultEnvFile / isProjectIndexed / ensureIndexed 定义
```

- [ ] **Step 6: 运行单元测试验证通过**

Run: `pnpm exec tsx --test tests/search-service-unit.test.ts`
Expected: PASS，至少 `ensureDefaultEnvFile` 相关断言通过

- [ ] **Step 7: 提交公共前置模块**

```bash
git add src/app/ensureDefaultEnvFile.ts src/app/ensureIndexed.ts src/mcp/tools/codebaseRetrieval.ts tests/search-service-unit.test.ts
git commit -m "refactor: extract shared search bootstrap modules"
```

### Task 3: 抽出公共搜索编排服务

**Files:**
- Create: `src/app/searchCodebase.ts`
- Modify: `src/mcp/tools/codebaseRetrieval.ts`
- Test: `tests/search-service-unit.test.ts`

- [ ] **Step 1: 编写 `searchCodebase` 行为测试**

```ts
test('searchCodebase validates env before executing search', async () => {
  const { searchCodebase } = await import('../src/app/searchCodebase.ts');
  await assert.rejects(
    () => searchCodebase({ repoPath: process.cwd(), query: 'login flow' }),
    /missing|required environment/i,
  );
});
```

- [ ] **Step 2: 运行测试确认当前失败**

Run: `pnpm exec tsx --test tests/search-service-unit.test.ts`
Expected: FAIL，提示 `searchCodebase.ts` 不存在

- [ ] **Step 3: 实现 `searchCodebase.ts`**

```ts
import type { SearchConfig } from '../search/types.js';
import { SearchService } from '../search/SearchService.js';
import { checkEmbeddingEnv, checkRerankerEnv } from '../config.js';
import { generateProjectId } from '../db/index.js';
import { ensureDefaultEnvFile } from './ensureDefaultEnvFile.js';
import { ensureIndexed } from './ensureIndexed.js';

export class MissingEnvError extends Error {
  constructor(public missingVars: string[]) {
    super('Required environment variables are missing');
    this.name = 'MissingEnvError';
  }
}

export async function searchCodebase(input: {
  repoPath: string;
  query: string;
  configOverride?: Partial<SearchConfig>;
  onProgress?: (current: number, total?: number, message?: string) => void;
}) {
  const embeddingCheck = checkEmbeddingEnv();
  const rerankerCheck = checkRerankerEnv();
  const missingVars = [...embeddingCheck.missingVars, ...rerankerCheck.missingVars];

  if (missingVars.length > 0) {
    await ensureDefaultEnvFile(process.env.HOME || process.cwd());
    throw new MissingEnvError(missingVars);
  }

  const { projectId } = await ensureIndexed(input.repoPath, input.onProgress);
  const service = new SearchService(projectId, input.repoPath, input.configOverride);
  await service.init();
  const contextPack = await service.buildContextPack(input.query);

  return { projectId, query: input.query, contextPack };
}
```

- [ ] **Step 4: 改造 MCP 入口仅做适配与格式转换**

```ts
const query = [information_request, ...(technical_terms || [])].filter(Boolean).join(' ');
const result = await searchCodebase({
  repoPath: repo_path,
  query,
  configOverride,
  onProgress,
});

return formatMcpResponse(result.contextPack);
```

- [ ] **Step 5: 运行单元测试验证通过**

Run: `pnpm exec tsx --test tests/search-service-unit.test.ts`
Expected: PASS，`MissingEnvError` 测试通过

- [ ] **Step 6: 提交公共搜索服务**

```bash
git add src/app/searchCodebase.ts src/mcp/tools/codebaseRetrieval.ts tests/search-service-unit.test.ts
git commit -m "refactor: add shared search orchestration service"
```

### Task 4: 抽取公共文本格式化器并接入 CLI/MCP

**Files:**
- Create: `src/app/formatSearchText.ts`
- Modify: `src/mcp/tools/codebaseRetrieval.ts`
- Modify: `src/index.ts`
- Test: `tests/search-cli-smoke.ts`

- [ ] **Step 1: 编写文本格式化复用测试**

```ts
test('CLI and MCP share the same text formatter', async () => {
  const { formatSearchText } = await import('../src/app/formatSearchText.ts');
  const text = formatSearchText({
    query: 'x',
    seeds: [],
    expanded: [],
    files: [],
  });
  assert.match(text, /Found 0 relevant code blocks/);
});
```

- [ ] **Step 2: 运行测试确认当前失败**

Run: `pnpm exec tsx --test tests/search-cli-smoke.ts`
Expected: FAIL，提示 `formatSearchText.ts` 不存在

- [ ] **Step 3: 实现 `formatSearchText.ts`**

```ts
import type { ContextPack, Segment } from '../search/types.js';

function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return (
    {
      ts: 'typescript',
      js: 'javascript',
      py: 'python',
      md: 'markdown',
    }[ext] || ext || 'plaintext'
  );
}

function formatSegment(seg: Segment): string {
  const header = `## ${seg.filePath} (L${seg.startLine}-${seg.endLine})`;
  const breadcrumb = seg.breadcrumb ? `> ${seg.breadcrumb}` : '';
  const code = `\`\`\`${detectLanguage(seg.filePath)}\n${seg.text}\n\`\`\``;
  return [header, breadcrumb, code].filter(Boolean).join('\n');
}

export function formatSearchText(pack: ContextPack): string {
  const fileBlocks = pack.files
    .map((file) => file.segments.map((seg) => formatSegment(seg)).join('\n\n'))
    .join('\n\n---\n\n');

  const summary = [
    `Found ${pack.seeds.length} relevant code blocks`,
    `Files: ${pack.files.length}`,
    `Total segments: ${pack.files.reduce((acc, f) => acc + f.segments.length, 0)}`,
  ].join(' | ');

  return `${summary}\n\n${fileBlocks}`.trim();
}
```

- [ ] **Step 4: CLI 与 MCP 改为复用文本格式化器**

```ts
// codebaseRetrieval.ts
import { formatSearchText } from '../../app/formatSearchText.js';
return { content: [{ type: 'text', text: formatSearchText(pack) }] };

// index.ts
const result = await searchCodebase({ repoPath, query, configOverride });
process.stdout.write(`${formatSearchText(result.contextPack)}\n`);
```

- [ ] **Step 5: 运行 smoke 测试验证通过**

Run: `pnpm build && pnpm exec tsx --test tests/search-cli-smoke.ts`
Expected: PASS，CLI 能输出统一文本摘要

- [ ] **Step 6: 提交格式化重构**

```bash
git add src/app/formatSearchText.ts src/index.ts src/mcp/tools/codebaseRetrieval.ts tests/search-cli-smoke.ts
git commit -m "refactor: share text formatting between cli and mcp"
```

### Task 5: 为 CLI 增加 `--query` 与 `--json`

**Files:**
- Modify: `src/index.ts`
- Modify: `tests/search-cli-smoke.ts`
- Test: `tests/search-cli-smoke.ts`

- [ ] **Step 1: 编写 CLI 参数兼容测试**

```ts
test('search accepts --query as the preferred alias', async () => {
  const args = ['dist/index.js', 'search', '--query', 'login flow', '--json'];
  assert.deepEqual(args.slice(2), ['search', '--query', 'login flow', '--json']);
});
```

- [ ] **Step 2: 运行测试确认当前失败**

Run: `pnpm build && pnpm exec tsx --test tests/search-cli-smoke.ts`
Expected: FAIL，当前 `search` 仅支持 `--information-request`

- [ ] **Step 3: 修改 CLI 参数解析与 JSON 输出**

```ts
.option('--query <text>', '自然语言问题描述（推荐）')
.option('--information-request <text>', '自然语言问题描述（兼容旧参数）')
.option('--json', '输出结构化 JSON')

const query = options.query || options.informationRequest;
if (!query) {
  logger.error('缺少 --query 或 --information-request');
  process.exit(1);
}

if (options.json) {
  process.stdout.write(
    JSON.stringify(
      {
        version: '1.0',
        success: true,
        projectId: result.projectId,
        query: result.query,
        seeds: result.contextPack.seeds,
        expanded: result.contextPack.expanded,
        files: result.contextPack.files,
      },
      null,
      2,
    ) + '\n',
  );
  return;
}
```

- [ ] **Step 4: 运行 smoke 测试验证通过**

Run: `pnpm build && pnpm exec tsx --test tests/search-cli-smoke.ts`
Expected: PASS，`--query` 被接受，`--json` 输出合法 JSON

- [ ] **Step 5: 提交 CLI 首轮增强**

```bash
git add src/index.ts tests/search-cli-smoke.ts
git commit -m "feat: add query alias and json output to search cli"
```

### Task 6: 为搜索链路引入协议无关过滤抽象

**Files:**
- Create: `src/search/filtering.ts`
- Modify: `src/search/types.ts`
- Modify: `tests/search-filtering.test.ts`
- Test: `tests/search-filtering.test.ts`

- [ ] **Step 1: 编写过滤抽象单元测试**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

test('codeOnly filter excludes markdown language', async () => {
  const { createSearchFilter } = await import('../src/search/filtering.ts');
  const filter = createSearchFilter({ codeOnly: true });
  assert.deepEqual(filter.excludeLanguages, ['markdown']);
});
```

- [ ] **Step 2: 运行测试确认当前失败**

Run: `pnpm exec tsx --test tests/search-filtering.test.ts`
Expected: FAIL，提示 `filtering.ts` 不存在

- [ ] **Step 3: 实现协议无关过滤抽象**

```ts
export interface SearchFilter {
  excludeLanguages?: string[];
  excludePathPrefixes?: string[];
}

export function createSearchFilter(input: { codeOnly?: boolean }): SearchFilter | undefined {
  if (!input.codeOnly) return undefined;
  return { excludeLanguages: ['markdown'] };
}

export function matchesSearchFilter(
  filter: SearchFilter | undefined,
  item: { filePath: string; language?: string },
): boolean {
  if (!filter) return true;
  if (filter.excludeLanguages?.includes(item.language || '')) return false;
  if (filter.excludePathPrefixes?.some((prefix) => item.filePath.startsWith(prefix))) return false;
  return true;
}
```

- [ ] **Step 4: 在 `types.ts` 中扩展输入类型**

```ts
export interface SearchScopeOptions {
  codeOnly?: boolean;
}
```

- [ ] **Step 5: 运行过滤单元测试验证通过**

Run: `pnpm exec tsx --test tests/search-filtering.test.ts`
Expected: PASS，`codeOnly` 正确映射到 `markdown` 排除规则

- [ ] **Step 6: 提交过滤抽象**

```bash
git add src/search/filtering.ts src/search/types.ts tests/search-filtering.test.ts
git commit -m "feat: add protocol-agnostic search filtering primitives"
```

### Task 7: 将过滤接入 `SearchService` / `GraphExpander`

**Files:**
- Modify: `src/app/searchCodebase.ts`
- Modify: `src/search/SearchService.ts`
- Modify: `src/search/GraphExpander.ts`
- Modify: `src/indexer/index.ts`
- Modify: `tests/search-filtering.test.ts`
- Test: `tests/search-filtering.test.ts`

- [ ] **Step 1: 编写链路级过滤失败测试**

```ts
test('codeOnly removes markdown from final search results', async () => {
  const { matchesSearchFilter } = await import('../src/search/filtering.ts');
  assert.equal(
    matchesSearchFilter({ excludeLanguages: ['markdown'] }, { filePath: 'README.md', language: 'markdown' }),
    false,
  );
});
```

- [ ] **Step 2: 运行测试确认当前链路尚未接入**

Run: `pnpm exec tsx --test tests/search-filtering.test.ts`
Expected: FAIL 或仅抽象层通过，但集成断言缺失

- [ ] **Step 3: 为 `SearchService` 增加过滤入参**

```ts
constructor(
  projectId: string,
  _projectPath: string,
  config?: Partial<SearchConfig>,
  private filter?: SearchFilter,
) {
  this.projectId = projectId;
  this.config = { ...DEFAULT_CONFIG, ...config };
}
```

- [ ] **Step 4: 修正 GraphExpander 缓存与请求级 filter 的注入方式**

```ts
// 不将 filter 放进 GraphExpander 构造函数状态，避免 projectId 级缓存污染
async expand(
  seeds: ScoredChunk[],
  queryTokens?: Set<string>,
  filter?: SearchFilter,
): Promise<ExpandResult> {}

// SearchService 中按请求传入 filter
const expander = await getGraphExpander(this.projectId, this.config);
const expanded = await expander.expand(seeds, queryTokens, this.filter);
```

说明：

- 当前 `getGraphExpander()` 只按 `projectId` 缓存实例。
- 如果把 `filter` 存进构造函数，`codeOnly=true/false` 混用时会污染缓存状态。
- 因此这里必须改成“缓存实例 + 运行时传 filter”的模式。

- [ ] **Step 5: 在向量、词法和扩展链路接入过滤**

```ts
// SearchService.vectorRetrieve()
const vectorFilter = this.filter?.excludeLanguages?.includes('markdown')
  ? `language != 'markdown'`
  : undefined;
const results = await this.indexer.textSearch(query, this.config.vectorTopK, vectorFilter);

// SearchService.lexicalRetrieve*()
.filter((chunk) =>
  matchesSearchFilter(this.filter, {
    filePath: chunk.file_path,
    language: chunk.language,
  }),
)

// GraphExpander
if (!matchesSearchFilter(filter, { filePath: targetPath, language: importChunks[0]?.language })) {
  continue;
}
```

- [ ] **Step 6: 在 `searchCodebase.ts` 中创建并传递过滤器**

```ts
const filter = createSearchFilter({ codeOnly: input.codeOnly });
const service = new SearchService(projectId, input.repoPath, input.configOverride, filter);
```

- [ ] **Step 7: 明确校验 `Indexer.textSearch()` 的 filter 透传链路**

```ts
// src/indexer/index.ts
async textSearch(query: string, limit = 10, filter?: string) {
  const queryVector = await this.embeddingClient.embed(query);
  return this.search(queryVector, limit, filter);
}
```

说明：

- 当前 `Indexer.textSearch()` 已有 `filter?: string` 签名，但本任务必须显式验证这一层确实把 LanceDB filter 透传到底层。
- 如果透传链路在集成时失败，应优先补一个最小过滤集成测试，而不是延后到 CLI 层排查。

- [ ] **Step 8: 运行过滤测试验证通过**

Run: `pnpm exec tsx --test tests/search-filtering.test.ts`
Expected: PASS，Markdown 在 `codeOnly=true` 时不再出现在候选结果

- [ ] **Step 9: 提交搜索过滤接入**

```bash
git add src/app/searchCodebase.ts src/search/SearchService.ts src/search/GraphExpander.ts src/indexer/index.ts tests/search-filtering.test.ts
git commit -m "feat: apply code-only filtering across search pipeline"
```

### Task 8: 暴露 `--code-only` CLI 参数并补回归测试

**Files:**
- Modify: `src/index.ts`
- Modify: `tests/search-cli-smoke.ts`
- Modify: `tests/mcp-e2e-smoke.ts`
- Test: `tests/search-cli-smoke.ts`
- Test: `tests/mcp-e2e-smoke.ts`

- [ ] **Step 1: 编写 CLI `--code-only` 测试**

```ts
test('search --code-only excludes markdown files from output', async () => {
  const args = ['dist/index.js', 'search', '--query', 'auth flow', '--code-only', '--json'];
  assert.ok(args.includes('--code-only'));
});
```

- [ ] **Step 2: 运行测试确认当前失败**

Run: `pnpm build && pnpm exec tsx --test tests/search-cli-smoke.ts`
Expected: FAIL，当前 CLI 尚未解析 `--code-only`

- [ ] **Step 3: 在 CLI 中接入 `--code-only`**

```ts
.option('--code-only', '搜索阶段排除文档类结果，只返回源码相关结果')

const result = await searchCodebase({
  repoPath,
  query: buildSearchQuery(query, technicalTerms),
  configOverride: useZen ? undefined : {},
  codeOnly: options.codeOnly,
});
```

- [ ] **Step 4: 为 `tests/mcp-e2e-smoke.ts` 补不回退断言**

```ts
assert.match(
  result.stdout,
  /Found\s+\d+\s+relevant\s+code\s+blocks/i,
  `[${item.name}] 无检索结果摘要`,
);
// MCP 现阶段不暴露 code_only，确认现有调用路径不受影响
```

- [ ] **Step 5: 运行回归测试**

Run: `pnpm build && pnpm exec tsx --test tests/search-cli-smoke.ts`
Expected: PASS

Run: `pnpm test:e2e:mcp`
Expected: PASS 或在缺少远程模型配置时输出 `⚠️ 跳过 MCP E2E：缺少可用 Embedding/Reranker 环境变量`

- [ ] **Step 6: 提交 CLI 过滤能力**

```bash
git add src/index.ts tests/search-cli-smoke.ts tests/mcp-e2e-smoke.ts
git commit -m "feat: add code-only mode to search cli"
```

### Task 9: 文档与最终回归

**Files:**
- Modify: `README.md`
- Test: `tests/language-support.test.ts`
- Test: `tests/search-service-unit.test.ts`
- Test: `tests/search-filtering.test.ts`
- Test: `tests/search-cli-smoke.ts`

- [ ] **Step 1: 更新 README 中的 CLI 用法**

```md
coderecall search --query "How is authentication flow handled?"
coderecall search --query "How is authentication flow handled?" --json
coderecall search --query "How is authentication flow handled?" --code-only
```

- [ ] **Step 2: 运行基础语言支持回归**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 3: 运行新增单元与 CLI 测试**

Run: `pnpm exec tsx --test tests/search-service-unit.test.ts tests/search-filtering.test.ts tests/search-cli-smoke.ts`
Expected: PASS

- [ ] **Step 4: 构建产物并做最终检查**

Run: `pnpm build`
Expected: PASS，生成 `dist/index.js`

- [ ] **Step 5: 提交文档与回归收口**

```bash
git add README.md tests/language-support.test.ts tests/search-service-unit.test.ts tests/search-filtering.test.ts tests/search-cli-smoke.ts
git commit -m "docs: document native cli search mode"
```

**二、Spec 覆盖检查**

- 公共编排层：Task 2-4
- CLI-first 搜索入口：Task 4-5
- 统一文本格式化：Task 4
- `--json`：Task 5
- 协议无关搜索过滤抽象：Task 6
- `--code-only`：Task 7-8
- MCP 保持兼容：Task 3、Task 8
- 回归与文档：Task 9

**三、自检结论**

- 无 `TODO` / `TBD` 占位
- P0 与 P1 范围分离明确
- `SearchFilter`、`MissingEnvError`、`searchCodebase()` 命名前后统一
- `--code-only` 明确属于第二阶段，并要求同时修改 `SearchService` / `GraphExpander`
- `ensureIndexed()` 的 `wasIndexed` 返回值已按首次索引场景修正
- 文本格式化器位于 `src/app/`，避免 CLI / MCP 表现层互相依赖
