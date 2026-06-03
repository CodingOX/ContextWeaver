import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EmbeddingClient } from '../../src/api/embedding.js';
import type { ProcessedChunk } from '../../src/chunking/types.js';
import { batchUpsert, closeDb, getFilesNeedingVectorIndex, initDb } from '../../src/db/index.js';
import { Indexer, splitIntoChunkBatches } from '../../src/indexer/index.js';
import { logger } from '../../src/utils/logger.js';

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
  return new Response(JSON.stringify({ error: { message: 'HTTP 429 Too Many Requests' } }), {
    status: 429,
    headers: { 'content-type': 'application/json' },
  });
}

async function withMutedErrorLogs<T>(fn: () => Promise<T>): Promise<T> {
  const originalError = logger.error.bind(logger);

  try {
    // 这些用例会主动制造失败分支，静音 error 日志，避免 CI 将预期失败误标为异常。
    (logger as typeof logger & { error: typeof logger.error }).error =
      (() => {}) as typeof logger.error;
    return await fn();
  } finally {
    (logger as typeof logger & { error: typeof logger.error }).error = originalError;
  }
}

test('429 后并发应减半（AIMD），首次退避 5s 后恢复', async () => {
  const client = new EmbeddingClient(TEST_CONFIG);
  const originalFetch = globalThis.fetch;
  const usedKeys: string[] = [];
  let callCount = 0;
  const startedAt = Date.now();

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
    const elapsedMs = Date.now() - startedAt;
    const status = client.getRateLimiterStatus();
    assert.deepEqual(usedKeys, ['key-alpha', 'key-alpha'], '429 重试应复用当前 Key');
    // 初始退避 5s，等待 >= 4.5s
    assert.ok(elapsedMs >= 4500, `第一次 429 后实际等待应接近 5s，当前仅 ${elapsedMs}ms`);
    // AIMD 减半：maxConcurrency=10 → 5
    assert.ok(
      status.currentConcurrency <= 5,
      `一次 429 后并发应减半，当前: ${status.currentConcurrency}`,
    );
    // 退避从 5s 翻倍到 10s
    assert.ok(status.backoffMs >= 5000, `429 后最小退避 >= 5s，当前: ${status.backoffMs}`);
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
    { path: 'a.ts', hash: 'h1', chunks: [{}, {}, {}] }, // 3 chunks
    { path: 'b.ts', hash: 'h2', chunks: [{}, {}] }, // 2 chunks
    { path: 'c.ts', hash: 'h3', chunks: [{}, {}, {}, {}] }, // 4 chunks
    { path: 'd.ts', hash: 'h4', chunks: [{}] }, // 1 chunk
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
    const result = await withMutedErrorLogs(() => indexer.batchIndex(db, files));

    assert.deepEqual(result, { success: 2, errors: 1 });
    assert.deepEqual(upsertedFiles, ['a.ts', 'c.ts']);
    assert.deepEqual(getFilesNeedingVectorIndex(db), ['b.ts']);
  } finally {
    closeDb(db);
    await fs.rm(path.join(os.homedir(), '.coderecall', projectId), {
      recursive: true,
      force: true,
    });
  }
});

test('batchIndex 子批次写入 LanceDB 失败时不应删除旧向量', async () => {
  const projectId = `batch-write-failure-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
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

  const files = ['old-a.ts', 'old-b.ts'].map((filePath, fileIndex) => ({
    path: filePath,
    hash: `hash-${fileIndex}`,
    chunks: Array.from({ length: 2 }, (_, chunkIndex) => makeChunk(chunkIndex, filePath)),
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
    ): Promise<Array<{ text: string; embedding: number[]; index: number }>> {
      return texts.map((t, i) => ({
        text: t,
        embedding: [i + 0.1, i + 0.2, i + 0.3],
        index: i,
      }));
    }
  }

  const deleteCalls: string[] = [];
  const upsertGroups: string[][] = [];
  const indexer = new Indexer(projectId, 3) as any;
  indexer.embeddingClient = new MockEmbeddingClient();
  indexer.vectorStore = {
    batchUpsertFiles: async (items: Array<{ path: string }>) => {
      upsertGroups.push(items.map((item) => item.path));
      if (items.some((item) => item.path === 'old-b.ts')) {
        throw new Error('mock lancedb failure');
      }
    },
    deleteFile: async (filePath: string) => {
      deleteCalls.push(filePath);
    },
  };

  try {
    const result = await withMutedErrorLogs(() => indexer.batchIndex(db, files));

    assert.deepEqual(result, { success: 0, errors: 2 });
    assert.deepEqual(upsertGroups, [['old-a.ts', 'old-b.ts']]);
    assert.deepEqual(deleteCalls, [], '写入失败时不应删除旧向量');
    assert.deepEqual(getFilesNeedingVectorIndex(db).sort(), ['old-a.ts', 'old-b.ts']);
  } finally {
    closeDb(db);
    await fs.rm(path.join(os.homedir(), '.coderecall', projectId), {
      recursive: true,
      force: true,
    });
  }
});

test('batchIndex 同一 outer batch 内应聚合写入 LanceDB 并按子批次确认', async () => {
  const projectId = `batch-grouped-upsert-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
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

  const files = ['group-a.ts', 'group-b.ts', 'group-c.ts'].map((filePath, fileIndex) => ({
    path: filePath,
    hash: `hash-${fileIndex}`,
    chunks: Array.from({ length: 2 }, (_, chunkIndex) => makeChunk(chunkIndex, filePath)),
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
    ): Promise<Array<{ text: string; embedding: number[]; index: number }>> {
      return texts.map((t, i) => ({
        text: t,
        embedding: [i + 0.1, i + 0.2, i + 0.3],
        index: i,
      }));
    }
  }

  const groupedCalls: string[][] = [];
  const indexer = new Indexer(projectId, 3) as any;
  indexer.embeddingClient = new MockEmbeddingClient();
  indexer.vectorStore = {
    batchUpsertFiles: async (items: Array<{ path: string }>) => {
      groupedCalls.push(items.map((item) => item.path));
    },
    deleteFile: async () => {},
  };

  try {
    const result = await indexer.batchIndex(db, files);
    assert.deepEqual(result, { success: 3, errors: 0 });
  } finally {
    closeDb(db);
    await fs.rm(path.join(os.homedir(), '.coderecall', projectId), {
      recursive: true,
      force: true,
    });
  }

  assert.deepEqual(
    groupedCalls,
    [['group-a.ts', 'group-b.ts', 'group-c.ts']],
    '同一 outer batch 内多个文件应聚合成一次 LanceDB 写入',
  );
});
