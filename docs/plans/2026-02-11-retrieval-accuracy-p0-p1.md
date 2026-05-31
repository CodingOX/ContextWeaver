# Retrieval Accuracy P0/P1 Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在不引入大规模架构变更的前提下，落地 P0/P1 的 4 项高收益优化：Rerank 降级、FTS 双重计分修复、查询分通道、融合前 per-file cap。

**Architecture:** 通过“小步可回滚”策略改造检索主链路：先修复确定性故障与计分偏差，再引入查询路由和候选多样性控制。实现上优先抽取可单测的纯函数（查询构建、候选截断），并让 `SearchService` 负责编排。所有改动均以 node:test 运行时测试先行，确保行为可回归。

**Tech Stack:** TypeScript (Node.js 20+ ESM)、node:test + assert、tsx、SQLite FTS5、LanceDB。

---

## 执行前置（必须）

1. 在独立工作树执行（推荐 `@using-git-worktrees`）：
   ```bash
   git worktree add ../ContextWeaver-retrieval-accuracy -b feat/retrieval-accuracy-p0-p1
   ```
2. 全流程遵循 `@test-driven-development`：先失败测试，再最小实现。
3. 完成前执行 `@verification-before-completion`：仅根据命令输出声明成功。
4. 每个 Task 完成后立即提交一次，避免大提交难回滚。

## 并行拓扑（按依赖）

```text
Task 1 (P0 rerank 降级) ----┐
                            ├--> Task 3 (查询分通道)
Task 2 (P0 FTS 计分修复) ---┘

Task 3 --> Task 4 (per-file cap)
Task 4 --> Task 5 (集成回归与文档收尾)
```

- `Task 1` 与 `Task 2` 可并行（无写冲突）。
- `Task 3/4` 都修改 `SearchService.ts`，必须串行。

### Task 1: Rerank 失败自动降级（P0）

**Files:**
- Modify: `src/search/SearchService.ts`
- Create: `tests/runtime/search-rerank-fallback.test.ts`

**Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { SearchService } from '../../src/search/SearchService.js';
import type { ScoredChunk } from '../../src/search/types.js';

const CANDIDATE: ScoredChunk = {
  filePath: 'src/demo.ts',
  chunkIndex: 0,
  score: 0.88,
  source: 'vector',
  record: {
    chunk_id: 'src/demo.ts#hash#0',
    file_path: 'src/demo.ts',
    file_hash: 'hash',
    chunk_index: 0,
    vector: [0],
    display_code: 'export const demo = 1;',
    vector_text: 'demo',
    language: 'typescript',
    breadcrumb: 'src/demo.ts > const demo',
    start_index: 0,
    end_index: 20,
    raw_start: 0,
    raw_end: 20,
    vec_start: 0,
    vec_end: 20,
    _distance: 0,
  },
};

test('rerank 失败时应降级到融合结果继续返回 seeds', async () => {
  const service = new SearchService('p', '/tmp/project');
  const anyService = service as any;

  anyService.hybridRetrieve = async () => [CANDIDATE];
  anyService.rerank = async () => {
    throw new Error('rerank down');
  };
  anyService.applySmartCutoff = (items: ScoredChunk[]) => items;
  anyService.expand = async () => [];

  const pack = await service.buildContextPack('find demo');

  assert.equal(pack.seeds.length, 1);
  assert.equal(pack.seeds[0].filePath, 'src/demo.ts');
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm -s tsx tests/runtime/search-rerank-fallback.test.ts`
Expected: FAIL（当前实现 rerank 抛错会中断 `buildContextPack`）

**Step 3: Write minimal implementation**

```ts
// src/search/SearchService.ts (buildContextPack)
let reranked: ScoredChunk[];
try {
  reranked = await this.rerank(rerankQuery, topM);
} catch (err) {
  const error = err as { message?: string };
  logger.warn({ error: error.message }, 'Rerank 不可用，降级到 RRF 融合结果');
  reranked = topM;
}
const seeds = this.applySmartCutoff(reranked);
```

**Step 4: Run test to verify it passes**

Run: `pnpm -s tsx tests/runtime/search-rerank-fallback.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/search/SearchService.ts tests/runtime/search-rerank-fallback.test.ts
git commit -m "fix(search): fallback to fused ranking when rerank fails"
```

### Task 2: 修复 chunks_fts breadcrumb 双重计分（P0）

**Files:**
- Modify: `src/indexer/index.ts`
- Create: `tests/runtime/chunk-fts-content.test.ts`

**Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChunkFtsDoc } from '../../src/indexer/index.js';

test('chunk FTS content 不应重复包含 breadcrumb', () => {
  const doc = buildChunkFtsDoc({
    chunkId: 'a#h#0',
    filePath: 'src/a.ts',
    chunkIndex: 0,
    breadcrumb: 'src/a.ts > class A > method run',
    displayCode: 'run() { return 1; }',
  });

  assert.equal(doc.breadcrumb, 'src/a.ts > class A > method run');
  assert.equal(doc.content, 'run() { return 1; }');
  assert.equal(doc.content.includes(doc.breadcrumb), false);
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm -s tsx tests/runtime/chunk-fts-content.test.ts`
Expected: FAIL（当前内容是 `${breadcrumb}\n${display_code}`）

**Step 3: Write minimal implementation**

```ts
// src/indexer/index.ts
export function buildChunkFtsDoc(input: {
  chunkId: string;
  filePath: string;
  chunkIndex: number;
  breadcrumb: string;
  displayCode: string;
}): {
  chunkId: string;
  filePath: string;
  chunkIndex: number;
  breadcrumb: string;
  content: string;
} {
  return {
    chunkId: input.chunkId,
    filePath: input.filePath,
    chunkIndex: input.chunkIndex,
    breadcrumb: input.breadcrumb,
    content: input.displayCode,
  };
}

// 在 batchIndex 收集 FTS 数据处调用 buildChunkFtsDoc
```

**Step 4: Run test to verify it passes**

Run: `pnpm -s tsx tests/runtime/chunk-fts-content.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/indexer/index.ts tests/runtime/chunk-fts-content.test.ts
git commit -m "fix(fts): remove breadcrumb duplication from chunk content field"
```

### Task 3: 查询分通道（P1）

**Files:**
- Create: `src/search/queryChannels.ts`
- Modify: `src/mcp/tools/codebaseRetrieval.ts`
- Modify: `src/search/SearchService.ts`
- Modify: `src/search/types.ts`
- Create: `tests/runtime/query-channel-build.test.ts`
- Create: `tests/runtime/search-query-routing.test.ts`

**Step 1: Write the failing tests**

```ts
// tests/runtime/query-channel-build.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildQueryChannels } from '../../src/search/queryChannels.js';

test('查询分通道构建符合语义/词法/rerank 预期', () => {
  const channels = buildQueryChannels({
    informationRequest: '如何处理登录流程',
    technicalTerms: ['AuthService', 'login'],
  });

  assert.equal(channels.vectorQuery, '如何处理登录流程');
  assert.equal(channels.lexicalQuery, 'AuthService login 如何处理登录流程');
  assert.equal(channels.rerankQuery, '如何处理登录流程 AuthService login');
});
```

```ts
// tests/runtime/search-query-routing.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { SearchService } from '../../src/search/SearchService.js';
import type { ScoredChunk } from '../../src/search/types.js';

const CANDIDATE = { /* 同 Task 1，可复用测试 fixture */ } as ScoredChunk;

test('SearchService 应按通道路由 query', async () => {
  const service = new SearchService('p', '/tmp/project');
  const anyService = service as any;

  let capturedVector = '';
  let capturedLexical = '';
  let capturedRerank = '';

  anyService.hybridRetrieve = async (vectorQuery: string, lexicalQuery: string) => {
    capturedVector = vectorQuery;
    capturedLexical = lexicalQuery;
    return [CANDIDATE];
  };
  anyService.rerank = async (rerankQuery: string, items: ScoredChunk[]) => {
    capturedRerank = rerankQuery;
    return items;
  };
  anyService.applySmartCutoff = (items: ScoredChunk[]) => items;
  anyService.expand = async () => [];

  await service.buildContextPack('fallback query', {
    vectorQuery: 'vector only',
    lexicalQuery: 'lexical only',
    rerankQuery: 'rerank full',
  });

  assert.equal(capturedVector, 'vector only');
  assert.equal(capturedLexical, 'lexical only');
  assert.equal(capturedRerank, 'rerank full');
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm -s tsx tests/runtime/query-channel-build.test.ts && pnpm -s tsx tests/runtime/search-query-routing.test.ts`
Expected: FAIL（尚无 `buildQueryChannels`，`buildContextPack` 也不支持通道参数）

**Step 3: Write minimal implementation**

```ts
// src/search/queryChannels.ts
export interface QueryChannels {
  vectorQuery: string;
  lexicalQuery: string;
  rerankQuery: string;
}

export function buildQueryChannels(input: {
  informationRequest: string;
  technicalTerms?: string[];
}): QueryChannels {
  const info = input.informationRequest.trim();
  const terms = Array.from(new Set((input.technicalTerms ?? []).map((t) => t.trim()).filter(Boolean)));

  return {
    vectorQuery: info,
    lexicalQuery: [terms.join(' '), info].filter(Boolean).join(' ').trim(),
    rerankQuery: [info, ...terms].filter(Boolean).join(' ').trim(),
  };
}
```

```ts
// src/search/types.ts
export interface QueryChannels {
  vectorQuery: string;
  lexicalQuery: string;
  rerankQuery: string;
}
```

```ts
// src/search/SearchService.ts
async buildContextPack(query: string, channels?: Partial<QueryChannels>): Promise<ContextPack> {
  const vectorQuery = channels?.vectorQuery ?? query;
  const lexicalQuery = channels?.lexicalQuery ?? query;
  const rerankQuery = channels?.rerankQuery ?? query;

  const candidates = await this.hybridRetrieve(vectorQuery, lexicalQuery);
  const reranked = await this.rerank(rerankQuery, topM);
}

private async hybridRetrieve(vectorQuery: string, lexicalQuery: string): Promise<ScoredChunk[]> {
  const [vectorResults, lexicalResults] = await Promise.all([
    this.vectorRetrieve(vectorQuery),
    this.lexicalRetrieve(lexicalQuery),
  ]);
  return lexicalResults.length === 0 ? vectorResults : this.fuse(vectorResults, lexicalResults);
}
```

```ts
// src/mcp/tools/codebaseRetrieval.ts
import { buildQueryChannels } from '../../search/queryChannels.js';

const channels = buildQueryChannels({
  informationRequest: information_request,
  technicalTerms: technical_terms,
});

const contextPack = await service.buildContextPack(channels.rerankQuery, channels);
```

**Step 4: Run tests to verify they pass**

Run: `pnpm -s tsx tests/runtime/query-channel-build.test.ts && pnpm -s tsx tests/runtime/search-query-routing.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/search/queryChannels.ts src/search/types.ts src/search/SearchService.ts src/mcp/tools/codebaseRetrieval.ts tests/runtime/query-channel-build.test.ts tests/runtime/search-query-routing.test.ts
git commit -m "feat(search): split query channels for vector lexical and rerank"
```

### Task 4: 融合后 Rerank 前增加 per-file cap（P1）

**Files:**
- Modify: `src/search/SearchService.ts`
- Modify: `src/search/config.ts`
- Modify: `src/search/types.ts`
- Create: `tests/runtime/per-file-cap.test.ts`

**Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPreRerankPerFileCap } from '../../src/search/SearchService.js';
import type { ScoredChunk } from '../../src/search/types.js';

function chunk(filePath: string, chunkIndex: number, score: number): ScoredChunk {
  return {
    filePath,
    chunkIndex,
    score,
    source: 'vector',
    record: {
      chunk_id: `${filePath}#h#${chunkIndex}`,
      file_path: filePath,
      file_hash: 'h',
      chunk_index: chunkIndex,
      vector: [0],
      display_code: 'x',
      vector_text: 'x',
      language: 'typescript',
      breadcrumb: `${filePath} > x`,
      start_index: 0,
      end_index: 1,
      raw_start: 0,
      raw_end: 1,
      vec_start: 0,
      vec_end: 1,
      _distance: 0,
    },
  };
}

test('per-file cap 应限制单文件进入 rerank 的候选数', () => {
  const input = [
    chunk('src/a.ts', 0, 0.99),
    chunk('src/a.ts', 1, 0.98),
    chunk('src/a.ts', 2, 0.97),
    chunk('src/b.ts', 0, 0.96),
    chunk('src/c.ts', 0, 0.95),
  ];

  const output = applyPreRerankPerFileCap(input, 2);
  const aCount = output.filter((c) => c.filePath === 'src/a.ts').length;

  assert.equal(aCount, 2);
  assert.equal(output.length, 4);
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm -s tsx tests/runtime/per-file-cap.test.ts`
Expected: FAIL（当前不存在该函数与配置）

**Step 3: Write minimal implementation**

```ts
// src/search/types.ts
export interface SearchConfig {
  // ...existing
  preRerankMaxPerFile: number;
}

// src/search/config.ts
preRerankMaxPerFile: 5,

// src/search/SearchService.ts
export function applyPreRerankPerFileCap(items: ScoredChunk[], maxPerFile: number): ScoredChunk[] {
  if (maxPerFile <= 0) return items;
  const counts = new Map<string, number>();
  const out: ScoredChunk[] = [];
  for (const item of items) {
    const used = counts.get(item.filePath) ?? 0;
    if (used >= maxPerFile) continue;
    counts.set(item.filePath, used + 1);
    out.push(item);
  }
  return out;
}

// buildContextPack 中：topM -> applyPreRerankPerFileCap -> rerank
```

**Step 4: Run test to verify it passes**

Run: `pnpm -s tsx tests/runtime/per-file-cap.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/search/SearchService.ts src/search/config.ts src/search/types.ts tests/runtime/per-file-cap.test.ts
git commit -m "feat(search): cap pre-rerank candidates per file"
```

### Task 5: 集成回归、脚本接入与文档收尾

**Files:**
- Modify: `package.json`
- Modify: `docs/todo.md`
- Modify: `README.md`（仅补充新配置项说明）

**Step 1: Write the failing test gate (将新增 runtime 测试纳入 test 脚本)**

```json
{
  "scripts": {
    "test": "... && tsx tests/runtime/search-rerank-fallback.test.ts && tsx tests/runtime/chunk-fts-content.test.ts && tsx tests/runtime/query-channel-build.test.ts && tsx tests/runtime/search-query-routing.test.ts && tsx tests/runtime/per-file-cap.test.ts"
  }
}
```

**Step 2: Run test to verify gate catches missing integration**

Run: `pnpm test`
Expected: 若任一新增测试未接入/失败，则整体 FAIL

**Step 3: Write minimal implementation**

- 更新 `package.json` 的 `test` 命令，加入 5 个新测试。
- 更新 `README.md`：新增 `preRerankMaxPerFile` 配置说明；补一句“Rerank 失败会自动降级”。
- 更新 `docs/todo.md`：将 P0/P1 已完成项从 `[ ]` 改为 `[x]`，并附提交 hash（可选）。

**Step 4: Run full verification**

Run:
```bash
pnpm -s tsx tests/runtime/search-rerank-fallback.test.ts
pnpm -s tsx tests/runtime/chunk-fts-content.test.ts
pnpm -s tsx tests/runtime/query-channel-build.test.ts
pnpm -s tsx tests/runtime/search-query-routing.test.ts
pnpm -s tsx tests/runtime/per-file-cap.test.ts
pnpm test
pnpm build
```
Expected:
- 全部 PASS
- `build` 成功产出 `dist/`

**Step 5: Commit**

```bash
git add package.json README.md docs/todo.md
git commit -m "chore(search): add regression tests and docs for retrieval hardening"
```

## 完成定义（Definition of Done）

- P0/P1 四项需求全部落地并有对应自动化测试。
- `pnpm test` 与 `pnpm build` 均通过。
- `docs/todo.md` 与 README 配置说明已同步，无行为文档漂移。
- 每个任务有独立提交，支持按任务回滚。
