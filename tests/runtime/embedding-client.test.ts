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
    assert.ok(requestBatchSizes.some((size) => size === 1), '发生 413 后应拆分到单条请求');
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

    assert.deepEqual(usedAuthHeaders, [
      'Bearer rr-key-1',
      'Bearer rr-key-2',
      'Bearer rr-key-1',
    ]);
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
