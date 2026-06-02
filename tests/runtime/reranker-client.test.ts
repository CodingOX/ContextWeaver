import assert from 'node:assert/strict';
import test from 'node:test';
import { getRerankerClient, RerankerClient, resetRerankerClient } from '../../src/api/reranker.js';

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

function withRerankerEnv<T>(fn: () => T): T {
  const prevApiKey = process.env.RERANK_API_KEY;
  const prevApiKeys = process.env.RERANK_API_KEYS;
  const prevBaseUrl = process.env.RERANK_BASE_URL;
  const prevModel = process.env.RERANK_MODEL;
  const prevTopN = process.env.RERANK_TOP_N;

  process.env.RERANK_API_KEY = SINGLE_KEY_CONFIG.apiKey;
  process.env.RERANK_API_KEYS = SINGLE_KEY_CONFIG.apiKey;
  process.env.RERANK_BASE_URL = SINGLE_KEY_CONFIG.baseUrl;
  process.env.RERANK_MODEL = SINGLE_KEY_CONFIG.model;
  process.env.RERANK_TOP_N = String(SINGLE_KEY_CONFIG.topN);

  try {
    return fn();
  } finally {
    if (prevApiKey === undefined) delete process.env.RERANK_API_KEY;
    else process.env.RERANK_API_KEY = prevApiKey;
    if (prevApiKeys === undefined) delete process.env.RERANK_API_KEYS;
    else process.env.RERANK_API_KEYS = prevApiKeys;
    if (prevBaseUrl === undefined) delete process.env.RERANK_BASE_URL;
    else process.env.RERANK_BASE_URL = prevBaseUrl;
    if (prevModel === undefined) delete process.env.RERANK_MODEL;
    else process.env.RERANK_MODEL = prevModel;
    if (prevTopN === undefined) delete process.env.RERANK_TOP_N;
    else process.env.RERANK_TOP_N = prevTopN;
  }
}

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

test('resetRerankerClient 后应返回新实例', { concurrency: false }, () => {
  withRerankerEnv(() => {
    resetRerankerClient();
    const first = getRerankerClient();
    const second = getRerankerClient();
    assert.equal(first, second, '未 reset 前应复用同一实例');

    resetRerankerClient();
    const third = getRerankerClient();
    assert.notEqual(first, third, 'reset 后应重新创建实例');
  });
});
