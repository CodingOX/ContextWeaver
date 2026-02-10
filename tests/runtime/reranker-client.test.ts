import assert from 'node:assert/strict';
import test from 'node:test';
import { RerankerClient } from '../../src/api/reranker.js';

const MULTI_KEY_CONFIG = {
  apiKey: 'rk-1',
  apiKeys: ['rk-1', 'rk-2'],
  baseUrl: 'https://example.com/rerank',
  model: 'test-rerank-model',
  topN: 5,
};

const SINGLE_KEY_CONFIG = {
  apiKey: 'rk-single',
  apiKeys: [],
  baseUrl: 'https://example.com/rerank',
  model: 'test-rerank-model',
  topN: 5,
};

function makeSuccessResponse(): Response {
  return new Response(
    JSON.stringify({
      id: 'rerank-test-id',
      results: [
        { index: 0, relevance_score: 0.9 },
        { index: 1, relevance_score: 0.8 },
      ],
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

test('连续请求应轮询使用不同 key', { concurrency: false }, async () => {
  const client = new RerankerClient(MULTI_KEY_CONFIG);
  const originalFetch = globalThis.fetch;
  const usedAuthHeaders: string[] = [];

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    usedAuthHeaders.push(headers.get('Authorization') || '');
    return makeSuccessResponse();
  }) as typeof fetch;

  try {
    await client.rerank('query-1', ['doc-1', 'doc-2'], { retries: 1 });
    await client.rerank('query-2', ['doc-3', 'doc-4'], { retries: 1 });

    assert.deepEqual(usedAuthHeaders, ['Bearer rk-1', 'Bearer rk-2']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('首次失败后重试应切换 key 并成功', { concurrency: false }, async () => {
  const client = new RerankerClient(MULTI_KEY_CONFIG);
  const originalFetch = globalThis.fetch;
  const usedAuthHeaders: string[] = [];
  let callCount = 0;

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    usedAuthHeaders.push(headers.get('Authorization') || '');
    callCount++;

    if (callCount === 1) {
      return makeErrorResponse(429, 'rate limited');
    }

    return makeSuccessResponse();
  }) as typeof fetch;

  try {
    const results = await client.rerank('query-retry', ['doc-1', 'doc-2'], { retries: 2 });

    assert.equal(results.length, 2);
    assert.deepEqual(usedAuthHeaders, ['Bearer rk-1', 'Bearer rk-2']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('单 key 配置应回退为固定 key 并保持可用', { concurrency: false }, async () => {
  const client = new RerankerClient(SINGLE_KEY_CONFIG);
  const originalFetch = globalThis.fetch;
  const usedAuthHeaders: string[] = [];

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    usedAuthHeaders.push(headers.get('Authorization') || '');
    return makeSuccessResponse();
  }) as typeof fetch;

  try {
    await client.rerank('query-1', ['doc-1', 'doc-2'], { retries: 1 });
    await client.rerank('query-2', ['doc-3', 'doc-4'], { retries: 1 });

    assert.deepEqual(usedAuthHeaders, ['Bearer rk-single', 'Bearer rk-single']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
