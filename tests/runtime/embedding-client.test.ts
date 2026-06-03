import assert from 'node:assert/strict';
import test from 'node:test';
import { EmbeddingClient } from '../../src/api/embedding.js';

const TEST_CONFIG = {
  apiKey: 'test-api-key',
  baseUrl: 'https://example.com/embeddings',
  model: 'test-model',
  maxConcurrency: 2,
  dimensions: 3,
};

function makeSuccessResponse(length: number): Response {
  return new Response(
    JSON.stringify({
      object: 'list',
      data: Array.from({ length }, (_, index) => ({
        object: 'embedding',
        index,
        embedding: [index + 0.1, index + 0.2, index + 0.3],
      })),
      model: TEST_CONFIG.model,
      usage: {
        prompt_tokens: 10,
        total_tokens: 10,
      },
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );
}

function makeErrorResponse(status: number, message: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        message,
      },
    }),
    {
      status,
      headers: { 'content-type': 'application/json' },
    },
  );
}

test('遇到 413 时应自动拆分批次并成功返回全部结果', async () => {
  const client = new EmbeddingClient(TEST_CONFIG);
  const originalFetch = globalThis.fetch;
  const requestBatchSizes: number[] = [];

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { input?: string[] };
    const batch = Array.isArray(body.input) ? body.input : [String(body.input ?? '')];
    requestBatchSizes.push(batch.length);

    if (batch.length > 1) {
      return makeErrorResponse(413, 'HTTP 413');
    }

    return makeSuccessResponse(batch.length);
  }) as typeof fetch;

  try {
    const texts = ['chunk-1', 'chunk-2', 'chunk-3'];
    const results = await client.embedBatch(texts, 3);

    assert.equal(results.length, texts.length);
    assert.deepEqual(
      results.map((item) => item.index),
      [0, 1, 2],
      '自动拆分后应保持原始顺序与全局索引',
    );
    assert.equal(requestBatchSizes[0], 3, '首轮应先按原始批次发送');
    assert.ok(
      requestBatchSizes.some((size) => size === 1),
      '发生 413 后应拆分到单条请求',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('单条文本触发 413 时应直接失败，不进行无意义拆分', async () => {
  const client = new EmbeddingClient(TEST_CONFIG);
  const originalFetch = globalThis.fetch;
  let requestCount = 0;

  globalThis.fetch = (async () => {
    requestCount++;
    return makeErrorResponse(413, 'HTTP 413');
  }) as typeof fetch;

  try {
    await assert.rejects(() => client.embedBatch(['single'], 1), /413/);
    assert.equal(requestCount, 1, '单条请求失败后不应再次重试');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('非 413 错误应保持原有行为直接抛出', async () => {
  const client = new EmbeddingClient(TEST_CONFIG);
  const originalFetch = globalThis.fetch;
  let requestCount = 0;

  globalThis.fetch = (async () => {
    requestCount++;
    return makeErrorResponse(500, 'HTTP 500');
  }) as typeof fetch;

  try {
    await assert.rejects(() => client.embedBatch(['a', 'b'], 2), /500/);
    assert.equal(requestCount, 1, '非 413 错误不应触发拆分重试');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('每次 HTTP 请求都应按 key 池轮询 Authorization', async () => {
  const client = new EmbeddingClient({
    ...TEST_CONFIG,
    apiKey: 'legacy-key',
    apiKeys: ['rr-key-1', 'rr-key-2'],
    maxConcurrency: 1,
  });
  const originalFetch = globalThis.fetch;
  const usedAuthHeaders: string[] = [];

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    usedAuthHeaders.push(headers.get('Authorization') || '');
    return makeSuccessResponse(1);
  }) as typeof fetch;

  try {
    await client.embedBatch(['t1', 't2', 't3'], 1);

    assert.deepEqual(usedAuthHeaders, ['Bearer rr-key-1', 'Bearer rr-key-2', 'Bearer rr-key-1']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('网络重试时应切换到下一个 key', async () => {
  const client = new EmbeddingClient({
    ...TEST_CONFIG,
    apiKey: 'legacy-key',
    apiKeys: ['retry-key-1', 'retry-key-2'],
    maxConcurrency: 1,
  });
  const originalFetch = globalThis.fetch;
  const usedAuthHeaders: string[] = [];
  let callCount = 0;

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    usedAuthHeaders.push(headers.get('Authorization') || '');
    callCount++;

    if (callCount === 1) {
      throw new Error('fetch failed');
    }

    return makeSuccessResponse(1);
  }) as typeof fetch;

  try {
    const results = await client.embedBatch(['retry-text'], 1);

    assert.equal(results.length, 1);
    assert.deepEqual(usedAuthHeaders, ['Bearer retry-key-1', 'Bearer retry-key-2']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('每个 key 应持有独立的速率限制状态，不共享降级窗口', async () => {
  const client = new EmbeddingClient({
    ...TEST_CONFIG,
    apiKey: 'legacy-key',
    apiKeys: ['pool-key-1', 'pool-key-2'],
    maxConcurrency: 4,
    maxRpm: 2000,
    maxTpm: 500000,
    keyConfigs: [
      { apiKey: 'pool-key-1', maxConcurrency: 1, maxRpm: 100, maxTpm: 1000 },
      { apiKey: 'pool-key-2', maxConcurrency: 3, maxRpm: 300, maxTpm: 3000 },
    ],
  } as any);

  const rateLimiters = (client as any).rateLimitersByKey as Map<string, any>;
  assert.equal(rateLimiters.size, 2, '每个 key 都应有单独的 limiter');

  const first = rateLimiters.get('pool-key-1');
  const second = rateLimiters.get('pool-key-2');

  assert.ok(first, 'key-1 limiter 应存在');
  assert.ok(second, 'key-2 limiter 应存在');
  assert.notEqual(first, second, '不同 key 不应复用同一个 limiter 实例');

  first['currentConcurrency'] = 1;
  first['backoffMs'] = 20000;

  const firstStatus = first.getStatus();
  const secondStatus = second.getStatus();

  assert.equal(firstStatus.currentConcurrency, 1);
  assert.equal(firstStatus.backoffMs, 20000);
  assert.equal(secondStatus.currentConcurrency, 3, '另一把 key 不应受降级影响');
  assert.equal(secondStatus.backoffMs, 5000, '另一把 key 应保持初始退避窗口');
});

test('批处理中某批次 403 失败后，onProgress 不再被调用', async () => {
  const client = new EmbeddingClient({ ...TEST_CONFIG, maxConcurrency: 5 });
  const originalFetch = globalThis.fetch;
  let fetchCallCount = 0;
  const progressCalls: Array<{ completed: number; total: number }> = [];

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    fetchCallCount++;
    const body = JSON.parse(String(init?.body ?? '{}')) as { input?: string[] };
    const batch = Array.isArray(body.input) ? body.input : [String(body.input ?? '')];

    if (fetchCallCount === 1) {
      return makeErrorResponse(403, 'HTTP 403');
    }

    await new Promise((r) => setTimeout(r, 50));
    return makeSuccessResponse(batch.length);
  }) as typeof fetch;

  try {
    await assert.rejects(
      () =>
        client.embedBatch(
          Array.from({ length: 15 }, (_, i) => `text-${i}`),
          3,
          (completed, total) => {
            progressCalls.push({ completed, total });
          },
        ),
      /403/,
    );

    await new Promise((r) => setTimeout(r, 200));

    assert.equal(progressCalls.length, 0, '403 失败后 onProgress 不应被调用');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('批处理中某批次 403 失败后，后续排队批次不再发出 HTTP 请求', async () => {
  const client = new EmbeddingClient({ ...TEST_CONFIG, maxConcurrency: 1 });
  const originalFetch = globalThis.fetch;
  let fetchCallCount = 0;

  globalThis.fetch = (async () => {
    fetchCallCount++;

    if (fetchCallCount === 1) {
      return makeErrorResponse(403, 'HTTP 403');
    }

    await new Promise((r) => setTimeout(r, 10));
    return makeSuccessResponse(1);
  }) as typeof fetch;

  try {
    await assert.rejects(
      () =>
        client.embedBatch(
          Array.from({ length: 10 }, (_, i) => `text-${i}`),
          1,
        ),
      /403/,
    );

    const countAfterReject = fetchCallCount;
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(fetchCallCount, countAfterReject, '403 后不应有额外的 HTTP 请求');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('正常批处理完成时行为不变（回归验证）', async () => {
  const client = new EmbeddingClient({ ...TEST_CONFIG, maxConcurrency: 2 });
  const originalFetch = globalThis.fetch;
  const progressCalls: Array<{ completed: number; total: number }> = [];

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { input?: string[] };
    const batch = Array.isArray(body.input) ? body.input : [String(body.input ?? '')];
    return makeSuccessResponse(batch.length);
  }) as typeof fetch;

  try {
    const texts = ['a', 'b', 'c', 'd'];
    const results = await client.embedBatch(texts, 2, (completed, total) => {
      progressCalls.push({ completed, total });
    });

    assert.equal(results.length, 4);
    assert.equal(progressCalls.length, 2, '2 个批次应产生 2 次回调');
    assert.deepEqual(progressCalls[progressCalls.length - 1], { completed: 2, total: 2 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
