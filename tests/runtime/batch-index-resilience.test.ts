import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EmbeddingClient } from '../../src/api/embedding.js';
import { batchUpsert, closeDb, getFilesNeedingVectorIndex, initDb } from '../../src/db/index.js';
import { Indexer, splitIntoChunkBatches } from '../../src/indexer/index.js';
import type { ProcessedChunk } from '../../src/chunking/types.js';

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
    assert.ok(status.currentConcurrency <= 2, `一次 429 后不应快速恢复到高并发，当前: ${status.currentConcurrency}`);
    assert.ok(status.backoffMs >= 10000, `429 后最小退避应保持保守，当前: ${status.backoffMs}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

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
    assert.equal(usedKeys[0], 'key-alpha');
    assert.equal(usedKeys[1], 'key-beta');
    assert.ok(callCount >= 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

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
    await client.embedBatch(['hello'], 1);
    assert.fail('应该抛出异常');
  } catch (err) {
    const msg = (err as Error).message;
    assert.ok(
      msg.includes('Embedding API 错误') || msg.includes('认证失败冷却期'),
      `意外错误消息: ${msg}`,
    );
    assert.deepEqual(usedKeys, ['key-alpha', 'key-beta', 'key-gamma']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('splitIntoChunkBatches 按 chunk 数正确分组', () => {
  const files = [
    { path: 'a.ts', hash: 'h1', chunks: [{}, {}, {}] },    // 3 chunks
    { path: 'b.ts', hash: 'h2', chunks: [{}, {}] },         // 2 chunks
    { path: 'c.ts', hash: 'h3', chunks: [{}, {}, {}, {}] }, // 4 chunks
    { path: 'd.ts', hash: 'h4', chunks: [{}] },             // 1 chunk
  ] as any[];

  const batches = splitIntoChunkBatches(files, 5);

  // 3+2=5 → batch1: [a, b]; 4+1=5 → batch2: [c, d]
  assert.equal(batches.length, 2);
  assert.equal(batches[0].length, 2);
  assert.equal(batches[1].length, 2);
});

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

test('splitIntoChunkBatches 空列表返回空数组', () => {
  const batches = splitIntoChunkBatches([], 100);
  assert.equal(batches.length, 0);
});

test('batchIndex Embedding 中间批次失败后继续处理后续批次（断点续传）', async () => {
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
