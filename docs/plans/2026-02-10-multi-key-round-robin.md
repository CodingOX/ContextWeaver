# Multi API Key Round-Robin (Embedding + Rerank) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 支持 `EMBEDDINGS_API_KEYS` 与 `RERANK_API_KEYS`（逗号分隔），并在向量与 rerank 请求中按请求级轮询 key，同时完全兼容现有单 key 配置。

**Architecture:** 在 `config.ts` 统一解析多 key 并输出标准化配置（`apiKey + apiKeys`），客户端无需关心环境变量细节。`EmbeddingClient` 与 `RerankerClient` 各自维护独立轮询游标，在每次请求（含重试）时选取下一个 key。通过配置解析测试、客户端轮询测试、文档守卫测试保障行为正确并防止回归。

**Tech Stack:** TypeScript (Node.js 20+ ESM)、`node:test` + `assert`、`tsx`、全局 `fetch` mock。

---

## 执行前置（必须）

1. 在独立工作树执行（推荐 `@using-git-worktrees`）：
   ```bash
   git worktree add ../ContextWeaver-multi-key -b feat/multi-key-round-robin
   ```
2. 开发过程遵循 `@test-driven-development`：先写失败测试，再写最小实现。
3. 完成前执行 `@verification-before-completion`：仅凭命令输出声明成功。

## 并行拓扑（符合仓库并行规范）

```text
Task 1（串行）
  └── Task 2（并行）
  └── Task 3（并行）
  └── Task 4（并行）
        └── Task 5（串行汇总验证）
```

- `Task 2/3/4` 互不写同一段代码，可并行。
- `Task 5` 必须等待并行任务全部完成后执行。

### Task 1: 配置层支持多 Key 解析与兼容

**Files:**
- Modify: `src/config.ts:55-190`
- Create: `tests/runtime/config-multi-key.test.ts`

**Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkEmbeddingEnv,
  checkRerankerEnv,
  getEmbeddingConfig,
  getRerankerConfig,
} from '../../src/config.js';

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const backup = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    fn();
  } finally {
    process.env = backup;
  }
}

test('EMBEDDINGS_API_KEYS 应被解析为轮询 key 列表', () => {
  withEnv(
    {
      EMBEDDINGS_API_KEY: undefined,
      EMBEDDINGS_API_KEYS: 'k1, k2 ,k3',
      EMBEDDINGS_BASE_URL: 'https://example.com/embeddings',
      EMBEDDINGS_MODEL: 'test-embedding',
      EMBEDDINGS_DIMENSIONS: '1024',
    },
    () => {
      const cfg = getEmbeddingConfig();
      assert.deepEqual(cfg.apiKeys, ['k1', 'k2', 'k3']);
      assert.equal(cfg.apiKey, 'k1');
      assert.equal(checkEmbeddingEnv().isValid, true);
    },
  );
});

test('RERANK_API_KEYS 应被解析为轮询 key 列表', () => {
  withEnv(
    {
      RERANK_API_KEY: undefined,
      RERANK_API_KEYS: 'r1,r2',
      RERANK_BASE_URL: 'https://example.com/rerank',
      RERANK_MODEL: 'test-rerank',
    },
    () => {
      const cfg = getRerankerConfig();
      assert.deepEqual(cfg.apiKeys, ['r1', 'r2']);
      assert.equal(cfg.apiKey, 'r1');
      assert.equal(checkRerankerEnv().isValid, true);
    },
  );
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm -s tsx tests/runtime/config-multi-key.test.ts`
Expected: FAIL（当前实现仅识别单 key，会报 `EMBEDDINGS_API_KEY 环境变量未设置` 或断言失败）

**Step 3: Write minimal implementation**

```ts
// src/config.ts
export interface EmbeddingConfig {
  apiKey: string;
  apiKeys: string[];
  baseUrl: string;
  model: string;
  maxConcurrency: number;
  dimensions: number;
}

export interface RerankerConfig {
  apiKey: string;
  apiKeys: string[];
  baseUrl: string;
  model: string;
  topN: number;
}

function parseApiKeyList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item !== DEFAULT_API_KEY_PLACEHOLDER);
}

function resolveApiKeys(singleKey: string | undefined, multiKeys: string | undefined): string[] {
  const keysFromMulti = parseApiKeyList(multiKeys);
  if (keysFromMulti.length > 0) return keysFromMulti;
  return parseApiKeyList(singleKey);
}

// checkEmbeddingEnv/checkRerankerEnv: 改为接受 “单 key 或多 key 任一存在”
// getEmbeddingConfig/getRerankerConfig: 返回 { apiKey: apiKeys[0], apiKeys, ... }
```

**Step 4: Run test to verify it passes**

Run: `pnpm -s tsx tests/runtime/config-multi-key.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/config.ts tests/runtime/config-multi-key.test.ts
git commit -m "feat(config): support comma-separated api key lists"
```

### Task 2: Embedding 客户端请求级轮询 Key

**Files:**
- Modify: `src/api/embedding.ts:322-590`
- Modify: `tests/runtime/embedding-client.test.ts`

**Step 1: Write the failing test**

```ts
test('多 key 场景下 Embedding 请求应轮询 Authorization', async () => {
  const client = new EmbeddingClient({
    ...TEST_CONFIG,
    apiKey: 'key-1',
    apiKeys: ['key-1', 'key-2'],
  });

  const originalFetch = globalThis.fetch;
  const usedAuthHeaders: string[] = [];

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    usedAuthHeaders.push(headers.get('Authorization') || '');
    return makeSuccessResponse(1);
  }) as typeof fetch;

  try {
    await client.embedBatch(['a', 'b', 'c'], 1);
    assert.deepEqual(usedAuthHeaders, ['Bearer key-1', 'Bearer key-2', 'Bearer key-1']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm -s tsx tests/runtime/embedding-client.test.ts`
Expected: FAIL（当前 Authorization 始终使用同一个 key）

**Step 3: Write minimal implementation**

```ts
// src/api/embedding.ts
export class EmbeddingClient {
  private config: EmbeddingConfig;
  private apiKeys: string[];
  private apiKeyCursor = 0;

  constructor(config?: EmbeddingConfig) {
    this.config = config || getEmbeddingConfig();
    this.apiKeys = this.config.apiKeys?.length ? [...this.config.apiKeys] : [this.config.apiKey];
    this.rateLimiter = getRateLimitController(this.config.maxConcurrency);
  }

  private nextApiKey(): string {
    const key = this.apiKeys[this.apiKeyCursor];
    this.apiKeyCursor = (this.apiKeyCursor + 1) % this.apiKeys.length;
    return key;
  }

  private async processBatch(...) {
    const apiKey = this.nextApiKey();
    const response = await fetch(this.config.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });
    ...
  }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm -s tsx tests/runtime/embedding-client.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/api/embedding.ts tests/runtime/embedding-client.test.ts
git commit -m "feat(embedding): rotate api keys per request"
```

### Task 3: Reranker 客户端轮询 Key（含重试）

**Files:**
- Modify: `src/api/reranker.ts:83-215`
- Create: `tests/runtime/reranker-client.test.ts`
- Modify: `package.json`（将新测试接入 `pnpm test`）

**Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { RerankerClient } from '../../src/api/reranker.js';

const TEST_CONFIG = {
  apiKey: 'rk-1',
  apiKeys: ['rk-1', 'rk-2'],
  baseUrl: 'https://example.com/rerank',
  model: 'test-rerank',
  topN: 5,
};

function okResponse(): Response {
  return new Response(
    JSON.stringify({
      id: 'rid-1',
      results: [
        { index: 0, relevance_score: 0.9 },
        { index: 1, relevance_score: 0.8 },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('Rerank 重试时应切换到下一个 key', async () => {
  const client = new RerankerClient(TEST_CONFIG);
  const originalFetch = globalThis.fetch;
  const usedAuthHeaders: string[] = [];
  let callCount = 0;

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    usedAuthHeaders.push(headers.get('Authorization') || '');
    callCount += 1;

    if (callCount === 1) {
      return errorResponse(429, 'rate limited');
    }
    return okResponse();
  }) as typeof fetch;

  try {
    await client.rerank('q', ['d1', 'd2'], { retries: 2 });
    assert.deepEqual(usedAuthHeaders, ['Bearer rk-1', 'Bearer rk-2']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm -s tsx tests/runtime/reranker-client.test.ts`
Expected: FAIL（当前重试仍使用同一个 key）

**Step 3: Write minimal implementation**

```ts
// src/api/reranker.ts
export class RerankerClient {
  private config: RerankerConfig;
  private apiKeys: string[];
  private apiKeyCursor = 0;

  constructor(config?: RerankerConfig) {
    this.config = config || getRerankerConfig();
    this.apiKeys = this.config.apiKeys?.length ? [...this.config.apiKeys] : [this.config.apiKey];
  }

  private nextApiKey(): string {
    const key = this.apiKeys[this.apiKeyCursor];
    this.apiKeyCursor = (this.apiKeyCursor + 1) % this.apiKeys.length;
    return key;
  }

  async rerank(...) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      const apiKey = this.nextApiKey();
      const response = await fetch(this.config.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
      });
      ...
    }
  }
}
```

同时更新 `package.json` 的 `test` 脚本，追加：

```json
"tsx tests/runtime/config-multi-key.test.ts && tsx tests/runtime/reranker-client.test.ts"
```

（按现有顺序插入，避免影响既有用例执行顺序。）

**Step 4: Run test to verify it passes**

Run: `pnpm -s tsx tests/runtime/reranker-client.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/api/reranker.ts tests/runtime/reranker-client.test.ts package.json
git commit -m "feat(rerank): rotate api keys across attempts"
```

### Task 4: 默认配置模板与 README 文档同步

**Files:**
- Modify: `src/index.ts:57-74`
- Modify: `src/mcp/tools/codebaseRetrieval.ts:91-108`
- Modify: `src/mcp/tools/codebaseRetrieval.ts:415-421`
- Modify: `README.md:76-93`
- Modify: `README.md:410-421`
- Create: `tests/runtime/multi-key-docs.test.ts`
- Modify: `package.json`（将文档守卫测试接入 `pnpm test`）

**Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';

const readme = fs.readFileSync('README.md', 'utf8');
const cliInitSource = fs.readFileSync('src/index.ts', 'utf8');
const mcpToolSource = fs.readFileSync('src/mcp/tools/codebaseRetrieval.ts', 'utf8');

assert.match(readme, /EMBEDDINGS_API_KEYS/);
assert.match(readme, /RERANK_API_KEYS/);
assert.match(cliInitSource, /EMBEDDINGS_API_KEYS/);
assert.match(mcpToolSource, /RERANK_API_KEYS/);
```

**Step 2: Run test to verify it fails**

Run: `pnpm -s tsx tests/runtime/multi-key-docs.test.ts`
Expected: FAIL（当前模板与文档未出现多 key 配置项）

**Step 3: Write minimal implementation**

在 `src/index.ts` 与 `src/mcp/tools/codebaseRetrieval.ts` 的默认 `.env` 模板中新增：

```env
# 可选：多个 key（逗号分隔，启用请求轮询）
# EMBEDDINGS_API_KEYS=key1,key2
# RERANK_API_KEYS=key1,key2
```

在 `README.md` 中补充：

```bash
# 单 key（兼容模式）
EMBEDDINGS_API_KEY=your-api-key-here
RERANK_API_KEY=your-api-key-here

# 多 key（推荐，逗号分隔，按请求轮询）
# EMBEDDINGS_API_KEYS=key-a,key-b,key-c
# RERANK_API_KEYS=key-a,key-b,key-c
```

并在环境变量表增加 `EMBEDDINGS_API_KEYS`、`RERANK_API_KEYS` 两行，标注为“可选，优先级高于单 key”。

**Step 4: Run test to verify it passes**

Run: `pnpm -s tsx tests/runtime/multi-key-docs.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/index.ts src/mcp/tools/codebaseRetrieval.ts README.md tests/runtime/multi-key-docs.test.ts package.json
git commit -m "docs(config): document multi-key round-robin settings"
```

### Task 5: 汇总验证与回归检查

**Files:**
- Modify: 无（仅执行验证）

**Step 1: Run focused runtime tests**

Run:

```bash
pnpm -s tsx tests/runtime/config-multi-key.test.ts
pnpm -s tsx tests/runtime/embedding-client.test.ts
pnpm -s tsx tests/runtime/reranker-client.test.ts
pnpm -s tsx tests/runtime/multi-key-docs.test.ts
```

Expected: 全部 PASS

**Step 2: Run full project tests**

Run: `pnpm test`
Expected: PASS（若存在与本需求无关的历史失败，需在 PR 描述中单独标注）

**Step 3: Build check**

Run: `pnpm build`
Expected: PASS，`dist` 正常产出

**Step 4: Manual smoke (optional but recommended)**

Run:

```bash
EMBEDDINGS_API_KEYS=key1,key2 RERANK_API_KEYS=key3,key4 contextweaver search
```

Expected: 搜索流程可执行，日志可见请求正常发出（不打印明文 key）。

**Step 5: Commit (if any final fixups)**

```bash
git add -A
git commit -m "test: finalize multi-key round-robin verification"
```

---

## 完成定义（Definition of Done）

- `EMBEDDINGS_API_KEYS` / `RERANK_API_KEYS` 支持逗号分隔并生效。
- 未配置多 key 时，单 key 行为与旧版本一致（向后兼容）。
- Embedding 与 Rerank 都按请求轮询 key，且 Rerank 重试会切换 key。
- 默认 `.env` 模板、MCP 缺失提示、README 全部同步更新。
- 新增测试全部通过，`pnpm test` 与 `pnpm build` 通过。

