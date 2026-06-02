# batchIndex 断点续传、多 Key 容错 & 429 缓解 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 让 `batchIndex` 支持 Embedding 失败后断点续传，多 Key 池中坏 Key 自动跳过，并降低大批量索引时 429 限流风暴的发生概率。

**Architecture:** `src/indexer/index.ts` 的 `batchIndex` 从"全量原子"重构为"按 Chunk 数分批的小原子循环"；`src/api/embedding.ts` 的 `processWithRateLimit` 新增 401/403 自动切 Key 分支，`getNextApiKey` 升级为带 TTL 的坏 Key 跳过机制；`RateLimitController` 放慢 429 后的并发恢复斜率，并避免短暂成功后过快降低退避时间。

**Tech Stack:** TypeScript ESM, Node 22, node:test + node:assert/strict, tsx runner, mock globalThis.fetch

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/api/embedding.ts` | 修改 | `EmbeddingClient`: 新增 `badKeys` Map、`getNextKeyIndex()`、`markKeyBad()`；`processBatch` 签名改为外部传入 apiKey；`processWithRateLimit` while 循环新增 401/403 分支；`RateLimitController` 放慢 429 后恢复 |
| `src/indexer/index.ts` | 修改 | 导出 `FileToIndex`、新增导出函数 `splitIntoChunkBatches`、常量 `BATCH_CHUNKS`；重写 `batchIndex` 方法 |
| `tests/runtime/batch-index-resilience.test.ts` | 创建 | 所有测试: splitIntoChunkBatches 单元测试、Key 容错测试、429 慢恢复测试、batchIndex 断点续传 mock 测试 |
| `tests/runtime/batch-index-resilience-integration.test.ts` | 创建 | 可选集成测试骨架：真实 LanceDB + 真实 embedding 环境下验证断点续传 |

**不动**：Scanner、VectorStore、FTS、DB 工具函数、scan() 编排、hash 检测分类、配置加载。

---

## 429 缓解策略

这次重构分两层处理 429：

1. **止损层**：`batchIndex` 按 chunk 分批，小批次独立落库。即使某批最终失败，已完成批次也不重跑。
2. **根因缓解层**：`RateLimitController` 降低恢复速度，避免 429 后短时间重新爬回高并发。

本计划不引入新的配置项，先用保守常量收口：

| 参数 | 当前值 | 调整后 | 目的 |
|------|--------|--------|------|
| `successesPerConcurrencyIncrease` | 3 | 10 | 429 后恢复更慢，避免快速回到 8/9/10 并发 |
| `successesPerBackoffDecrease` | 10（隐式） | 50（显式） | 需要更长稳定窗口才降低退避时间 |
| `minBackoffMs` | 5000 | 10000 | 429 后最短冷却更保守 |

> **注意**：`EMBEDDINGS_MAX_CONCURRENCY` 仍由环境变量控制。如果线上/本机仍反复 429，优先把它降到 `4` 或 `5` 再观察。

---

### Task 1: EmbeddingClient — 坏 Key 跳过机制（数据结构 + 辅助方法）

**Files:**
- Modify: `src/api/embedding.ts:334-365`

#### 1.1 添加 `badKeys` 属性和常量

在 `EmbeddingClient` 类中，`private nextApiKeyIndex = 0;` (line 335) 之后新增：

```typescript
  private nextApiKeyIndex = 0;
  /** 坏 Key 冷却表: keyIndex → 解禁时间戳 (ms)，过期后自动恢复 */
  private badKeys = new Map<number, number>();
  /** 坏 Key 冷却时长 (5 分钟) */
  private readonly BAD_KEY_BAN_MS = 5 * 60 * 1000;
```

#### 1.2 重构 `getNextApiKey()` → `getNextKeyIndex()`

将 `getNextApiKey()` (lines 361-365) 替换为返回索引的 `getNextKeyIndex()`：

```typescript
  /**
   * 获取下一个健康 Key 的索引（跳过冷却期内的坏 Key）
   *
   * 返回 -1 表示当前所有 Key 都在冷却期。这里不能清空 badKeys 后
   * 直接重试，否则所有 Key 都 401/403 时会形成无限循环。
   */
  private getNextKeyIndex(): number {
    const now = Date.now();

    // 清理已过冷却期的坏 Key 标记
    for (const [idx, banUntil] of this.badKeys) {
      if (now >= banUntil) this.badKeys.delete(idx);
    }

    const start = this.nextApiKeyIndex;
    for (let i = 0; i < this.apiKeyPool.length; i++) {
      const idx = (start + i) % this.apiKeyPool.length;
      const banUntil = this.badKeys.get(idx);
      if (banUntil === undefined || now >= banUntil) {
        this.badKeys.delete(idx);
        this.nextApiKeyIndex = (idx + 1) % this.apiKeyPool.length;
        return idx;
      }
    }

    // 所有 Key 都在冷却期：由调用方决定是否失败或等待，不能盲目重试
    return -1;
  }
```

#### 1.3 添加 `markKeyBad()` 方法

在 `getNextKeyIndex()` 之后新增：

```typescript
  /**
   * 标记 Key 为不可用（设置冷却期）
   */
  private markKeyBad(index: number): void {
    const banUntil = Date.now() + this.BAD_KEY_BAN_MS;
    this.badKeys.set(index, banUntil);
    logger.warn({ keyIndex: index, banUntil: new Date(banUntil).toISOString() }, 'API Key 已标记为不可用，5 分钟后重新尝试');
  }
```

#### 1.4 更新 `buildApiKeyPool()` 中残留引用

确认 `buildApiKeyPool()` (lines 346-356) 和 `getNextApiKey()` 的替换不影响其他内部引用 —— `getNextApiKey()` 不再是直接返回 Key 的方法，需检查调用方。当前仅 `processBatch()` (line 620) 调用它，此修改将在 Task 2 处理。

---

### Task 2: EmbeddingClient — processBatch / processWithRateLimit 重构

**Files:**
- Modify: `src/api/embedding.ts:424-534` (processWithRateLimit)
- Modify: `src/api/embedding.ts:614-655` (processBatch)

#### 2.1 `processBatch` 签名改为接收外部 apiKey

替换 `processBatch` 方法 (lines 614-655) 的签名和首行：

```typescript
  private async processBatch(
    texts: string[],
    startIndex: number,
    progress: ProgressTracker,
    signal: AbortSignal | undefined,
    apiKey: string,
  ): Promise<EmbeddingResult[]> {
    const requestBody: EmbeddingRequest = {
      model: this.config.model,
      input: texts,
      encoding_format: 'float',
    };
    // ... 其余 body 不变 (lines 622-655)
```

删除原 line 620 (`const apiKey = this.getNextApiKey();`)。

#### 2.2 添加 `isAuthError` 辅助方法

在 `isPayloadTooLarge()` (line 586) 附近新增：

```typescript
  /**
   * 判断是否为认证错误 (401/403)
   */
  private isAuthError(err: unknown): boolean {
    const error = err as { message?: string; status?: number };
    const message = (error.message || '').toLowerCase();
    return message.includes('401') || message.includes('403')
      || message.includes('unauthorized') || message.includes('forbidden');
  }
```

#### 2.3 重写 `processWithRateLimit` while 循环

替换整个 `processWithRateLimit` 方法 (lines 424-534)：

```typescript
  /**
   * 带速率限制、网络重试、Key 自动切换的批次处理
   */
  private async processWithRateLimit(
    texts: string[],
    startIndex: number,
    progress: ProgressTracker,
    signal?: AbortSignal,
  ): Promise<EmbeddingResult[]> {
    const MAX_NETWORK_RETRIES = 3;
    const INITIAL_RETRY_DELAY_MS = 1000;

    let networkRetries = 0;
    let currentKeyIndex: number | null = null;
    let currentApiKey: string | null = null;
    const authTriedKeyIndexes = new Set<number>();

    while (true) {
      if (signal?.aborted) {
        throw new Error('Embedding 批处理已中止');
      }

      await this.rateLimiter.acquire();

      if (signal?.aborted) {
        this.rateLimiter.releaseFailure();
        throw new Error('Embedding 批处理已中止');
      }

      // 首次进入或 401 切 Key 后重新取 Key
      if (currentKeyIndex === null) {
        currentKeyIndex = this.getNextKeyIndex();
        if (currentKeyIndex < 0) {
          this.rateLimiter.releaseFailure();
          throw new Error('所有 Embedding API Key 均处于认证失败冷却期');
        }
        currentApiKey = this.apiKeyPool[currentKeyIndex];
      }

      if (currentApiKey === null) {
        this.rateLimiter.releaseFailure();
        throw new Error('未获取到可用 Embedding API Key');
      }

      try {
        const result = await this.processBatch(texts, startIndex, progress, signal, currentApiKey);
        this.rateLimiter.releaseSuccess();
        return result;
      } catch (err) {
        if (signal?.aborted) {
          this.rateLimiter.releaseFailure();
          throw new Error('Embedding 批处理已中止');
        }

        const error = err as { message?: string; code?: string };
        const errorMessage = error.message || '';
        const isRateLimited = errorMessage.includes('429') || errorMessage.includes('rate');
        const isNetworkError = this.isNetworkError(err);
        const isPayloadTooLarge = this.isPayloadTooLarge(err);
        const isAuthErr = this.isAuthError(err);

        if (isRateLimited) {
          this.rateLimiter.releaseForRetry();
          await this.rateLimiter.triggerRateLimit();
          networkRetries = 0;
        } else if (isNetworkError && networkRetries < MAX_NETWORK_RETRIES) {
          networkRetries++;
          const delayMs = INITIAL_RETRY_DELAY_MS * 2 ** (networkRetries - 1);
          logger.warn(
            { error: errorMessage, retry: networkRetries, maxRetries: MAX_NETWORK_RETRIES, delayMs },
            '网络错误，准备重试',
          );
          this.rateLimiter.releaseForRetry();
          // 保留现有契约：网络重试会轮询到下一个 Key，而不是固定复用当前 Key。
          currentKeyIndex = null;
          currentApiKey = null;
          await sleep(delayMs);
        } else if (isAuthErr) {
          if (currentKeyIndex !== null) {
            authTriedKeyIndexes.add(currentKeyIndex);
            this.markKeyBad(currentKeyIndex);
          }

          if (this.apiKeyPool.length > 1 && authTriedKeyIndexes.size < this.apiKeyPool.length) {
            // 401/403：标记坏 Key，下次循环换 Key 重试；单批最多尝试每个 Key 一次
            logger.warn({ keyIndex: currentKeyIndex, error: errorMessage }, 'API Key 认证失败，切换到下一个 Key');
            currentKeyIndex = null;
            currentApiKey = null;
            this.rateLimiter.releaseForRetry();
            networkRetries = 0;
          } else {
            this.rateLimiter.releaseFailure();
            throw err;
          }
        } else if (isPayloadTooLarge && texts.length > 1) {
          this.rateLimiter.releaseForRetry();
          const splitIndex = Math.ceil(texts.length / 2);
          const leftTexts = texts.slice(0, splitIndex);
          const rightTexts = texts.slice(splitIndex);
          progress.expandTotal(1);
          logger.warn(
            { error: errorMessage, batchSize: texts.length, leftBatchSize: leftTexts.length, rightBatchSize: rightTexts.length },
            'Embedding 请求体过大，自动拆分批次重试',
          );
          const leftResults = await this.processWithRateLimit(leftTexts, startIndex, progress, signal);
          const rightResults = await this.processWithRateLimit(rightTexts, startIndex + leftTexts.length, progress, signal);
          return [...leftResults, ...rightResults];
        } else {
          this.rateLimiter.releaseFailure();
          if (isNetworkError) {
            logger.error({ error: errorMessage, retries: networkRetries }, '网络错误重试次数耗尽');
          }
          throw err;
        }
      }
    }
  }
```

#### 2.4 Step 2: 运行现有测试确保无回归

```bash
tsx tests/runtime/embedding-client.test.ts
```

**Expected:** 8 个测试全部通过。

---

### Task 3: RateLimitController — 429 后慢恢复策略

**Files:**
- Modify: `src/api/embedding.ts:172-226` (RateLimitController 常量与恢复逻辑)
- Modify: `src/api/embedding.ts:250-292` (triggerRateLimit 日志字段可选增强)

#### 3.1 放慢并发恢复斜率

替换 `RateLimitController` 中的恢复相关常量：

```typescript
  /** 恢复并发所需的连续成功次数：429 后慢恢复，避免快速回到高并发再次撞限流 */
  private readonly successesPerConcurrencyIncrease = 10;
  /** 降低退避时间所需的连续成功次数：需要较长稳定窗口才认为限流解除 */
  private readonly successesPerBackoffDecrease = 50;
  /** 最小退避时间 */
  private readonly minBackoffMs = 10000;
  /** 最大退避时间 */
  private readonly maxBackoffMs = 60000;
```

#### 3.2 修改 `releaseSuccess()` 中的退避降低条件

将原来的“连续成功 10 次后减少退避”替换为显式常量控制：

```typescript
    // 连续成功足够多次后，才逐步减少退避时间。
    // 429 通常说明 provider 侧吞吐已接近上限，过早降低 backoff 会导致反复抖动。
    if (this.consecutiveSuccesses > 0 && this.consecutiveSuccesses % this.successesPerBackoffDecrease === 0) {
      this.backoffMs = Math.max(this.minBackoffMs, this.backoffMs / 2);
    }
```

#### 3.3 可选增强 429 日志

`triggerRateLimit()` 的 warn 日志保留现有字段，并补充恢复策略参数，便于从日志判断是否仍过激：

```typescript
        successesPerConcurrencyIncrease: this.successesPerConcurrencyIncrease,
        successesPerBackoffDecrease: this.successesPerBackoffDecrease,
```

#### 3.4 运行现有测试确保无回归

```bash
tsx tests/runtime/embedding-client.test.ts
```

**Expected:** 8 个测试全部通过。

---

### Task 4: 测试 — Embedding Key 容错与 429 慢恢复

**Files:**
- Create: `tests/runtime/batch-index-resilience.test.ts`

在新建的测试文件中，先写 `EmbeddingClient` 的 Key 容错测试和 429 慢恢复测试。

```typescript
import assert from 'node:assert/strict';
import test from 'node:test';
import { EmbeddingClient } from '../../src/api/embedding.js';

const TEST_CONFIG = {
  apiKey: 'key-alpha',
  apiKeys: ['key-alpha', 'key-beta', 'key-gamma'],
  baseUrl: 'https://example.com/embeddings',
  model: 'test-model',
  maxConcurrency: 10,
  dimensions: 3,
};

const SINGLE_KEY_CONFIG = {
  apiKey: 'only-key',
  baseUrl: 'https://example.com/embeddings',
  model: 'test-model',
  maxConcurrency: 2,
  dimensions: 3,
};

function makeSuccessEmbeddingResponse(texts: string[]): Response {
  return new Response(
    JSON.stringify({
      object: 'list',
      data: texts.map((_, i) => ({ object: 'embedding', index: i, embedding: [0.1, 0.2, 0.3] })),
      model: 'test-model',
      usage: { prompt_tokens: 10, total_tokens: 10 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function makeAuthErrorResponse(): Response {
  return new Response(
    JSON.stringify({ error: { message: 'HTTP 401 Unauthorized', type: 'auth_error' } }),
    { status: 401, headers: { 'content-type': 'application/json' } },
  );
}

function makeRateLimitResponse(): Response {
  return new Response(
    JSON.stringify({ error: { message: 'HTTP 429 Too Many Requests' } }),
    { status: 429, headers: { 'content-type': 'application/json' } },
  );
}
```

#### 4.1 测试: 429 后并发慢恢复

此测试必须放在文件中的第一个 `test()`。`RateLimitController` 是模块级全局实例，首个 `EmbeddingClient` 的 `maxConcurrency` 会决定本进程内全局 limiter 的上限。

```typescript
test('429 后并发恢复应更保守，避免快速回到 maxConcurrency', async () => {
  const client = new EmbeddingClient(TEST_CONFIG);
  const originalFetch = globalThis.fetch;
  const usedKeys: string[] = [];
  let callCount = 0;

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    callCount++;
    const authHeader = (init?.headers as Record<string, string>)?.Authorization ?? '';
    usedKeys.push(authHeader.replace('Bearer ', ''));

    if (callCount === 1) {
      return makeRateLimitResponse();
    }
    return makeSuccessEmbeddingResponse(['hello']);
  }) as typeof globalThis.fetch;

  try {
    await client.embedBatch(['hello'], 1);
    const status = client.getRateLimiterStatus();
    assert.deepEqual(usedKeys, ['key-alpha', 'key-alpha'], '429 重试应复用当前 Key');
    assert.ok(status.currentConcurrency <= 2, '一次 429 后不应快速恢复到高并发');
    assert.ok(status.backoffMs >= 10000, '429 后最小退避应保持保守');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

> **注意**：这个测试会等待一次最小 429 backoff，预计耗时约 10s。不要用 fake timer 简化它，避免绕过真实 `triggerRateLimit()` 行为。

#### 4.2 测试: 多 Key 池中 1 个 401 → 自动切 Key 完成

```typescript
test('多 Key 池中 1 个 Key 返回 401 时自动切到下一个 Key 并完成', async () => {
  const client = new EmbeddingClient(TEST_CONFIG);
  const usedKeys: string[] = [];
  const originalFetch = globalThis.fetch;

  let callCount = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    callCount++;
    const authHeader = (init?.headers as Record<string, string>)?.Authorization ?? '';
    const key = authHeader.replace('Bearer ', '');
    usedKeys.push(key);

    if (key === 'key-alpha') {
      return makeAuthErrorResponse();
    }
    return makeSuccessEmbeddingResponse(['hello', 'world']);
  }) as typeof globalThis.fetch;

  try {
    const results = await client.embedBatch(['hello', 'world'], 2);
    assert.equal(results.length, 2);
    // 第一次用 key-alpha (401), 第二次应该用 key-beta
    assert.equal(usedKeys[0], 'key-alpha');
    assert.equal(usedKeys[1], 'key-beta');
    assert.ok(callCount >= 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

#### 4.3 测试: 单 Key 池 401 → 抛出异常（不切换）

```typescript
test('单 Key 池 401 时直接抛出异常，不尝试切换', async () => {
  const client = new EmbeddingClient(SINGLE_KEY_CONFIG);
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => makeAuthErrorResponse()) as typeof globalThis.fetch;

  try {
    await client.embedBatch(['hello'], 1);
    assert.fail('应该抛出异常');
  } catch (err) {
    assert.ok((err as Error).message.includes('Embedding API 错误'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

#### 4.4 测试: 多 Key 全部 401 → 有界失败（防无限循环）

```typescript
test('多 Key 全部 401 时最多尝试每个 Key 一次后失败', async () => {
  const client = new EmbeddingClient(TEST_CONFIG);
  const usedKeys: string[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const authHeader = (init?.headers as Record<string, string>)?.Authorization ?? '';
    usedKeys.push(authHeader.replace('Bearer ', ''));
    return makeAuthErrorResponse();
  }) as typeof globalThis.fetch;

  try {
    await assert.rejects(() => client.embedBatch(['hello'], 1), /Embedding API 错误|认证失败冷却期/);
    assert.deepEqual(usedKeys, ['key-alpha', 'key-beta', 'key-gamma']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

#### 4.5 运行测试验证

```bash
tsx tests/runtime/batch-index-resilience.test.ts
```

**Expected:** Key 容错与 429 慢恢复测试全部 PASS；其中“全部 401”测试必须证明不会无限循环。

---

### Task 5: Indexer — `FileToIndex` 导出与 `splitIntoChunkBatches` 辅助函数

**Files:**
- Modify: `src/indexer/index.ts` — 在 `ChunkFtsDocInput` 接口后、`Indexer` 类前插入

先把现有 `interface FileToIndex` 改为导出，避免导出的 `splitIntoChunkBatches()` 在 d.ts 中引用非导出类型：

```diff
-interface FileToIndex {
+export interface FileToIndex {
   path: string;
   hash: string;
   chunks: ProcessedChunk[];
 }
```

然后在 `src/indexer/index.ts` line 51 (`export interface ChunkFtsDocInput { ... }`) 之后、line 53 (`const CODE_IDENTIFIER_REGEX`) 之前插入：

```typescript
/** 每批最多处理的 Chunk 数（控制单批 API 并发请求数 ≤ 20） */
export const BATCH_CHUNKS = 400;

/**
 * 按 Chunk 数动态分组文件列表
 *
 * 目标：控制每批 Embedding 请求的并发数在可控范围。
 * BATCH_CHUNKS=400 → 每批最多 20 个 API 并发请求 (400÷20 chunk/req)。
 */
export function splitIntoChunkBatches(
  files: FileToIndex[],
  maxChunks: number,
): FileToIndex[][] {
  const batches: FileToIndex[][] = [];
  let current: FileToIndex[] = [];
  let currentChunkCount = 0;

  for (const file of files) {
    if (currentChunkCount + file.chunks.length > maxChunks && current.length > 0) {
      batches.push(current);
      current = [file];
      currentChunkCount = file.chunks.length;
    } else {
      current.push(file);
      currentChunkCount += file.chunks.length;
    }
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
}
```

---

### Task 6: 测试 — `splitIntoChunkBatches`

**Files:**
- Modify: `tests/runtime/batch-index-resilience.test.ts` — 继续追加

在文件头部追加导入：

```typescript
import { splitIntoChunkBatches } from '../../src/indexer/index.js';
```

然后追加以下测试（在 Key 容错测试之后，但逻辑上应先于 batchIndex 测试）：

#### 6.1 测试: 基本分组

```typescript
test('splitIntoChunkBatches 按 chunk 数正确分组', () => {
  const files = [
    { path: 'a.ts', hash: 'h1', chunks: [{}, {}, {}] },  // 3 chunks
    { path: 'b.ts', hash: 'h2', chunks: [{}, {}] },       // 2 chunks
    { path: 'c.ts', hash: 'h3', chunks: [{}, {}, {}, {}] }, // 4 chunks
    { path: 'd.ts', hash: 'h4', chunks: [{}] },           // 1 chunk
  ] as any[];

  const batches = splitIntoChunkBatches(files, 5);

  // 3+2=5 → batch1: [a, b]; 4+1=5 → batch2: [c, d]
  assert.equal(batches.length, 2);
  assert.equal(batches[0].length, 2); // a, b (3+2=5)
  assert.equal(batches[1].length, 2); // c, d (4+1=5)
});
```

#### 6.2 测试: 单大文件单独成批

```typescript
test('splitIntoChunkBatches 单文件 chunk 数超上限时单独成批', () => {
  const files = [
    { path: 'huge.ts', hash: 'h1', chunks: new Array(500) },
    { path: 'small.ts', hash: 'h2', chunks: new Array(3) },
  ] as any[];

  const batches = splitIntoChunkBatches(files, 50);

  assert.equal(batches.length, 2);
  assert.equal(batches[0].length, 1); // huge.ts 单独
  assert.equal(batches[1].length, 1); // small.ts
});
```

#### 6.3 测试: 空列表

```typescript
test('splitIntoChunkBatches 空列表返回空数组', () => {
  const batches = splitIntoChunkBatches([], 100);
  assert.equal(batches.length, 0);
});
```

#### 6.4 运行验证

```bash
tsx tests/runtime/batch-index-resilience.test.ts
```

**Expected:** splitIntoChunkBatches 的三个测试 PASS（因为函数在 Task 5 已实现）。

---

### Task 7: Indexer — `batchIndex` 方法重构

**Files:**
- Modify: `src/indexer/index.ts:275-431` — 整个 `batchIndex` 方法替换

替换 `batchIndex` 方法体 (从 `private async batchIndex(...` 到 `return { success: ... }; }` 结束，约 lines 275-431)：

```typescript
  /**
   * 批量索引文件（断点续传版）
   *
   * 每 BATCH_CHUNKS 个 chunk 为一批，逐批独立完成:
   * 收集 → Embedding → 写库 → 标记 hash。
   * 单批失败不影响其他批次。
   */
  private async batchIndex(
    db: Database.Database,
    files: FileToIndex[],
    onProgress?: (indexed: number, total: number) => void,
  ): Promise<{ success: number; errors: number }> {
    if (files.length === 0) {
      return { success: 0, errors: 0 };
    }

    const batches = splitIntoChunkBatches(files, BATCH_CHUNKS);
    const totalEmbeddingRequests = batches.reduce((sum, batch) => {
      const chunks = batch.reduce((count, file) => count + file.chunks.length, 0);
      return sum + Math.ceil(chunks / 20);
    }, 0);
    let completedEmbeddingRequests = 0;
    let totalSuccess = 0;
    let totalErrors = 0;

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];

      // ===== 阶段 1: 收集本批 texts + 文件范围映射 =====
      const batchTexts: string[] = [];
      const fileRanges: Array<{ fileIdx: number; start: number; end: number }> = [];

      for (let fi = 0; fi < batch.length; fi++) {
        const file = batch[fi];
        const start = batchTexts.length;
        for (const chunk of file.chunks) {
          batchTexts.push(chunk.vectorText);
        }
        fileRanges.push({ fileIdx: fi, start, end: batchTexts.length });
      }

      if (batchTexts.length === 0) {
        continue;
      }

      // ===== 阶段 2: Embedding =====
      const batchEmbeddingRequests = Math.ceil(batchTexts.length / 20);
      let embeddings: number[][];
      try {
        const client = this.getOrCreateEmbeddingClient();
        const results = await client.embedBatch(batchTexts, 20, (completed, _total) => {
          // 每个 chunk batch 都会新建 ProgressTracker，这里统一折算为全局进度。
          onProgress?.(completedEmbeddingRequests + completed, totalEmbeddingRequests);
        });
        completedEmbeddingRequests += batchEmbeddingRequests;
        embeddings = results.map((r) => r.embedding);
      } catch (err) {
        const error = err as { message?: string; stack?: string };
        logger.error({ error: error.message, stack: error.stack }, 'Embedding 失败');
        completedEmbeddingRequests += batchEmbeddingRequests;
        clearVectorIndexHash(
          db,
          batch.map((f) => f.path),
        );
        totalErrors += batch.length;
        continue;
      }

      // ===== 阶段 3-4: 组装 ChunkRecord 并逐文件写 LanceDB =====
      const successFiles: Array<{ path: string; hash: string }> = [];
      const errorFiles: string[] = [];
      const successFtsChunks: ChunkFtsDoc[] = [];

      for (let fi = 0; fi < batch.length; fi++) {
        const file = batch[fi];
        const range = fileRanges.find((r) => r.fileIdx === fi);
        if (!range) {
          errorFiles.push(file.path);
          continue;
        }

        try {
          const records: ChunkRecord[] = [];
          const fileFtsChunks: ChunkFtsDoc[] = [];

          for (let ci = 0; ci < file.chunks.length; ci++) {
            const chunk = file.chunks[ci];
            const embedding = embeddings[range.start + ci];

            const record: ChunkRecord = {
              chunk_id: `${file.path}#${file.hash}#${ci}`,
              file_path: file.path,
              file_hash: file.hash,
              chunk_index: ci,
              vector: embedding,
              display_code: chunk.displayCode,
              vector_text: chunk.vectorText,
              language: chunk.metadata.language,
              breadcrumb: chunk.metadata.contextPath.join(' > '),
              start_index: chunk.metadata.startIndex,
              end_index: chunk.metadata.endIndex,
              raw_start: chunk.metadata.rawSpan.start,
              raw_end: chunk.metadata.rawSpan.end,
              vec_start: chunk.metadata.vectorSpan.start,
              vec_end: chunk.metadata.vectorSpan.end,
            };

            records.push(record);

            fileFtsChunks.push(
              buildChunkFtsDoc({
                chunkId: record.chunk_id,
                filePath: record.file_path,
                chunkIndex: record.chunk_index,
                breadcrumb: record.breadcrumb,
                displayCode: record.display_code,
              }),
            );
          }

          // 单文件写入 LanceDB
          await this.vectorStore!.batchUpsertFiles([
            { path: file.path, hash: file.hash, records },
          ]);
          successFiles.push({ path: file.path, hash: file.hash });
          // 只有向量写入成功后，才能把对应 FTS 文档加入成功集合，避免 FTS 脏数据。
          successFtsChunks.push(...fileFtsChunks);
        } catch (err) {
          const error = err as { message?: string; stack?: string };
          logger.error(
            { path: file.path, error: error.message },
            '写入 LanceDB 失败',
          );
          // 清理可能已写入的旧向量
          try {
            await this.vectorStore!.deleteFile(file.path);
          } catch {
            /* 尽力清理，忽略二次错误 */
          }
          errorFiles.push(file.path);
        }
      }

      // ===== 阶段 5: FTS 更新 =====
      if (successFiles.length > 0 && isChunksFtsInitialized(db)) {
        try {
          const pathsToDelete = successFiles.map((f) => f.path);
          batchDeleteFileChunksFts(db, pathsToDelete);
          batchUpsertChunkFts(db, successFtsChunks);
        } catch (err) {
          const error = err as { message?: string };
          logger.warn({ error: error.message }, 'FTS 批量更新失败（向量索引已成功）');
        }
      }

      // ===== 阶段 6: 标记完成 =====
      if (successFiles.length > 0) {
        batchUpdateVectorIndexHash(db, successFiles);
      }

      totalSuccess += successFiles.length;
      totalErrors += errorFiles.length;
    }

    logger.info(
      { success: totalSuccess, errors: totalErrors },
      '批量索引完成',
    );

    return { success: totalSuccess, errors: totalErrors };
  }
```

#### 7.1 确认不再使用的旧变量已清理

检查原 `batchIndex` 中的 `globalIndexByFileChunk: number[][]` 变量是否已被新代码中的 `fileRanges` 完全替代 —— 确认不需要添加额外的清理逻辑。

---

### Task 8: 测试 — `batchIndex` 断点续传

**Files:**
- Modify: `tests/runtime/batch-index-resilience.test.ts` — 继续追加

#### 8.1 测试: batchIndex 中间批失败后继续处理后续批次

```typescript
test('batchIndex Embedding 中间批次失败后继续处理后续批次（断点续传）', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { batchUpsert, closeDb, getFilesNeedingVectorIndex, initDb } = await import('../../src/db/index.js');
  const { Indexer } = await import('../../src/indexer/index.js');
  const { EmbeddingClient } = await import('../../src/api/embedding.js');

  const projectId = `batch-resilience-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const db = initDb(projectId);

  function makeChunk(index: number, filePath: string): ProcessedChunk {
    return {
      displayCode: `// chunk ${index} from ${filePath}`,
      vectorText: `vector text ${index} for ${filePath}`,
      nwsSize: 50,
      metadata: {
        filePath,
        language: 'typescript',
        contextPath: [filePath],
        startIndex: index * 10,
        endIndex: index * 10 + 5,
        rawSpan: { start: index * 10, end: index * 10 + 5 },
        vectorSpan: { start: index * 10, end: index * 10 + 5 },
      },
    };
  }

  const files = ['a.ts', 'b.ts', 'c.ts'].map((filePath, fileIndex) => ({
    path: filePath,
    hash: `hash-${fileIndex}`,
    chunks: Array.from({ length: 401 }, (_, chunkIndex) => makeChunk(chunkIndex, filePath)),
  }));

  batchUpsert(
    db,
    files.map((file) => ({
      path: file.path,
      hash: file.hash,
      mtime: Date.now(),
      size: 100,
      content: '// test',
      language: 'typescript',
      vectorIndexHash: null,
    })),
  );

  let embedCallCount = 0;
  class MockEmbeddingClient extends EmbeddingClient {
    constructor() {
      super({
        apiKey: 'test-key',
        baseUrl: 'https://example.com/embeddings',
        model: 'test',
        maxConcurrency: 1,
        dimensions: 3,
      });
    }

    override async embedBatch(
      texts: string[],
      _batchSize?: number,
      onProgress?: (completed: number, total: number) => void,
    ): Promise<Array<{ text: string; embedding: number[]; index: number }>> {
      embedCallCount++;
      if (embedCallCount === 2) {
        throw new Error('Embedding API 错误: HTTP 401');
      }
      onProgress?.(Math.ceil(texts.length / 20), Math.ceil(texts.length / 20));
      return texts.map((t, i) => ({
        text: t,
        embedding: [i + 0.1, i + 0.2, i + 0.3],
        index: i,
      }));
    }
  }

  const upsertedFiles: string[] = [];
  const indexer = new Indexer(projectId, 3) as any;
  indexer.embeddingClient = new MockEmbeddingClient();
  indexer.vectorStore = {
    batchUpsertFiles: async (items: Array<{ path: string }>) => {
      upsertedFiles.push(...items.map((item) => item.path));
    },
    deleteFile: async () => {},
  };

  try {
    const result = await indexer.batchIndex(db, files);

    assert.deepEqual(result, { success: 2, errors: 1 });
    assert.deepEqual(upsertedFiles, ['a.ts', 'c.ts']);
    assert.deepEqual(getFilesNeedingVectorIndex(db), ['b.ts']);
  } finally {
    closeDb(db);
    await fs.rm(path.join(os.homedir(), '.coderecall', projectId), { recursive: true, force: true });
  }
});
```

> **注意**: 此测试需要在文件头部已有 `assert`、`test` 的基础上追加 `type ProcessedChunk` 导入：
> `import type { ProcessedChunk } from '../../src/chunking/types.js';`

#### 8.2 运行现有索引自愈回归

```bash
tsx tests/runtime/index-healing-convergence.test.ts
```

**Expected:** PASS — 确认自愈收敛逻辑未被破坏。

---

### Task 9: 可选集成测试 — 真实 LanceDB 冒烟

**Files:**
- Create: `tests/runtime/batch-index-resilience-integration.test.ts`

断点续传的失败注入由 Task 8 的 mock 单测覆盖。此测试只在配置了真实 Embedding API 时运行，用来确认真实 LanceDB + SQLite 元数据链路仍能完整收敛。

```typescript
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { closeDb, batchUpsert, getFilesNeedingVectorIndex, initDb, type FileMeta } from '../../src/db/index.js';
import { closeAllIndexers, getIndexer } from '../../src/indexer/index.js';
import { closeAllVectorStores } from '../../src/vectorStore/index.js';
import type { ProcessResult } from '../../src/scanner/processor.js';
import type { ProcessedChunk } from '../../src/chunking/types.js';

const TEST_PROJECT = 'test-batch-index-resilience';
const TEST_DIR = path.join(os.homedir(), '.coderecall', TEST_PROJECT);

function makeChunk(index: number, filePath: string): ProcessedChunk {
  return {
    displayCode: `// chunk ${index} from ${filePath}`,
    vectorText: `vector text ${index} for embedding`,
    nwsSize: 50,
    metadata: {
      filePath,
      language: 'typescript',
      contextPath: [filePath],
      startIndex: index * 100,
      endIndex: (index + 1) * 100,
      rawSpan: { start: index * 100, end: (index + 1) * 100 },
      vectorSpan: { start: index * 100, end: (index + 1) * 100 },
    },
  };
}

test('真实 LanceDB 冒烟: 分批索引成功后 files 元数据收敛', { skip: !process.env.EMBEDDINGS_API_KEY && !process.env.EMBEDDINGS_API_KEYS }, async () => {
  // 此测试需要真实 embedding API，默认 skip
  // 设置环境变量后运行: EMBEDDINGS_API_KEY=xxx tsx tests/runtime/batch-index-resilience-integration.test.ts

  const db = initDb(TEST_PROJECT);
  const indexer = await getIndexer(TEST_PROJECT);

  // 创建 60 个文件，每个 10 chunks = 600 chunks → 2 批 (BATCH_CHUNKS=400)
  const results: ProcessResult[] = [];
  const files: FileMeta[] = [];
  for (let i = 0; i < 60; i++) {
    const filePath = `src/file-${String(i).padStart(3, '0')}.ts`;
    const hash = `hash-${String(i).padStart(3, '0')}`;
    const chunks: ProcessedChunk[] = [];
    for (let j = 0; j < 10; j++) {
      chunks.push(makeChunk(j, filePath));
    }
    files.push({
      path: filePath,
      hash,
      mtime: Date.now(),
      size: 100,
      content: '// mock content',
      language: 'typescript',
      vectorIndexHash: null,
    });
    results.push({
      absPath: `/tmp/${filePath}`,
      relPath: filePath,
      hash,
      status: 'added' as const,
      content: '// mock content',
      chunks,
      language: 'typescript',
      mtime: Date.now(),
      size: 100,
    });
  }

  try {
    batchUpsert(db, files);

    // 批次完成 → 验证 hash 标记
    const stats = await indexer.indexFiles(db, results);
    assert.equal(stats.errors, 0);
    assert.equal(stats.indexed, 60);

    // 验证: 成功索引的文件在后续 scan 中被标记为 unchanged
    const needingIndex = getFilesNeedingVectorIndex(db);
    assert.equal(needingIndex.length, 0, '所有文件应已标记为向量索引完成');
  } finally {
    closeDb(db);
    closeAllIndexers();
    await closeAllVectorStores();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
});
```

> **说明**：不要把此测试当作断点续传失败注入测试；它只验证真实存储链路。断点续传语义由 Task 8 的可控 mock 单测负责。

---

### Task 10: 最终验证与提交

#### 10.1 运行全量单元测试

```bash
pnpm test
```

**Expected:** package.json 中声明的全量 runtime 回归全部通过。

#### 10.2 运行 TypeScript 类型检查

```bash
pnpm tsc --noEmit
```

**Expected:** 无类型错误。

#### 10.3 运行 embedding-client 回归测试

```bash
tsx tests/runtime/embedding-client.test.ts
```

**Expected:** 8 个测试全部通过（确认 `processWithRateLimit` 重构未破坏现有行为）。

#### 10.4 运行新测试

```bash
tsx tests/runtime/batch-index-resilience.test.ts
```

**Expected:** 所有测试通过。

#### 10.5 提交

```bash
git add src/api/embedding.ts src/indexer/index.ts tests/runtime/batch-index-resilience.test.ts tests/runtime/batch-index-resilience-integration.test.ts
git commit -m "feat: batchIndex 断点续传 + 多 Key 容错

- embedding.ts: getNextApiKey → getNextKeyIndex，返回值改为索引；新增 badKeys
  Map (5min TTL) 和 markKeyBad()；processBatch 接收外部 apiKey
- embedding.ts: processWithRateLimit 新增 401/403 分支，自动切 Key 重试并限制单批认证尝试次数
- embedding.ts: RateLimitController 放慢 429 后并发恢复，延长最小退避窗口
- indexer/index.ts: 新增 splitIntoChunkBatches() 按 chunk 数动态分组
- indexer/index.ts: batchIndex 从全量原子重构为按 BATCH_CHUNKS(400) 分批循环
- indexer/index.ts: LanceDB 写入改为单文件粒度，FTS 仅写成功文件，失败时 deleteFile 清理
- tests: 新增 Key 容错、429 慢恢复、分组、断点续传测试"
```

---

## 自审清单

**1. Spec 覆盖**：
- ✅ 4.2 按 Chunk 数动态分组 → Task 5 (`splitIntoChunkBatches`)
- ✅ 4.3 batchIndex 重写 → Task 7
- ✅ 4.4 LanceDB 写入失败清理 → Task 7 (deleteFile catch 块)
- ✅ FTS 成功边界 → Task 7 (`successFtsChunks` 仅收集成功写入文件)
- ✅ 4.5.1 重试循环 Key 获取时机 → Task 2 (currentKeyIndex = null 模式)
- ✅ 4.5.2 坏 Key TTL 恢复 → Task 1 (badKeys Map + BAD_KEY_BAN_MS)
- ✅ 4.5.3 全部 Key 认证失败有界退出 → Task 2 (`authTriedKeyIndexes`)
- ✅ 429 慢恢复策略 → Task 3 (`successesPerConcurrencyIncrease=10`, `minBackoffMs=10000`)
- ✅ 8. 测试策略 → Task 4, 6, 8, 9

**2. Placeholder 扫描**：无 "TBD"、"TODO"、"implement later"、"write tests for above"、`assert.ok(true)` 等占位符或假测试。

**3. 类型一致性**：
- `badKeys: Map<number, number>` → Task 1 定义，Task 2 使用 ✅
- `getNextKeyIndex(): number` → Task 1 定义，返回 `-1` 表示全部冷却，Task 2 显式处理 ✅
- `successesPerBackoffDecrease: number` → Task 3 定义，`releaseSuccess()` 使用 ✅
- `FileToIndex` → Task 5 改为导出，匹配 `splitIntoChunkBatches` 的导出签名 ✅
- `splitIntoChunkBatches(files, maxChunks): FileToIndex[][]` → Task 5 定义，Task 7 batchIndex 使用 ✅
- `BATCH_CHUNKS = 400` → Task 5 定义，Task 7 使用 ✅
- `buildChunkFtsDoc` → Task 7 复用现有导出 ✅
- `batchUpdateVectorIndexHash`, `clearVectorIndexHash` → Task 7 复用现有导入 ✅
- `batchUpsert` + `FileMeta` → Task 8/9 测试先写入 `files` 元数据，避免 `vector_index_hash` UPDATE 假通过 ✅
