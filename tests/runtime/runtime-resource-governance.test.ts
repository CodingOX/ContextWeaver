import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  EmbeddingClient,
  getEmbeddingClient,
  resetEmbeddingClient,
  resetRateLimitController,
} from '../../src/api/embedding.js';
import {
  __getTokenBoundaryRegexCacheSizeForTest,
  __resetTokenBoundaryRegexCacheForTest,
  getTokenBoundaryRegexForTest,
} from '../../src/search/SearchService.js';
import { __getOpenLogStreamCountForTest, __shutdownLoggerForTest } from '../../src/utils/logger.js';
import { VectorStore } from '../../src/vectorStore/index.js';

const TEST_CONFIG = {
  apiKey: 'test-api-key',
  baseUrl: 'https://example.com/embeddings',
  model: 'test-model',
  maxConcurrency: 2,
  dimensions: 3,
};

async function withEmbeddingEnv<T>(fn: () => T | Promise<T>): Promise<T> {
  const prevApiKey = process.env.EMBEDDINGS_API_KEY;
  const prevApiKeys = process.env.EMBEDDINGS_API_KEYS;
  const prevBaseUrl = process.env.EMBEDDINGS_BASE_URL;
  const prevModel = process.env.EMBEDDINGS_MODEL;
  const prevDimensions = process.env.EMBEDDINGS_DIMENSIONS;
  const prevMaxConcurrency = process.env.EMBEDDINGS_MAX_CONCURRENCY;
  const prevMaxRpm = process.env.EMBEDDINGS_MAX_RPM;
  const prevMaxTpm = process.env.EMBEDDINGS_MAX_TPM;
  const prevKeyMaxConcurrencies = process.env.EMBEDDINGS_KEY_MAX_CONCURRENCIES;
  const prevKeyMaxRpms = process.env.EMBEDDINGS_KEY_MAX_RPMS;
  const prevKeyMaxTpms = process.env.EMBEDDINGS_KEY_MAX_TPMS;
  const prevRateProfile = process.env.EMBEDDINGS_RATE_PROFILE;
  const prevCodeRecallProfile = process.env.CODE_RECALL_PROFILE;

  process.env.EMBEDDINGS_API_KEY = TEST_CONFIG.apiKey;
  process.env.EMBEDDINGS_API_KEYS = TEST_CONFIG.apiKey;
  process.env.EMBEDDINGS_BASE_URL = TEST_CONFIG.baseUrl;
  process.env.EMBEDDINGS_MODEL = TEST_CONFIG.model;
  process.env.EMBEDDINGS_DIMENSIONS = String(TEST_CONFIG.dimensions);
  process.env.EMBEDDINGS_MAX_CONCURRENCY = String(TEST_CONFIG.maxConcurrency);
  process.env.EMBEDDINGS_MAX_RPM = '2000';
  process.env.EMBEDDINGS_MAX_TPM = '500000';
  delete process.env.EMBEDDINGS_KEY_MAX_CONCURRENCIES;
  delete process.env.EMBEDDINGS_KEY_MAX_RPMS;
  delete process.env.EMBEDDINGS_KEY_MAX_TPMS;
  process.env.EMBEDDINGS_RATE_PROFILE = 'balanced';
  process.env.CODE_RECALL_PROFILE = 'balanced';

  try {
    return await fn();
  } finally {
    if (prevApiKey === undefined) delete process.env.EMBEDDINGS_API_KEY;
    else process.env.EMBEDDINGS_API_KEY = prevApiKey;
    if (prevApiKeys === undefined) delete process.env.EMBEDDINGS_API_KEYS;
    else process.env.EMBEDDINGS_API_KEYS = prevApiKeys;
    if (prevBaseUrl === undefined) delete process.env.EMBEDDINGS_BASE_URL;
    else process.env.EMBEDDINGS_BASE_URL = prevBaseUrl;
    if (prevModel === undefined) delete process.env.EMBEDDINGS_MODEL;
    else process.env.EMBEDDINGS_MODEL = prevModel;
    if (prevDimensions === undefined) delete process.env.EMBEDDINGS_DIMENSIONS;
    else process.env.EMBEDDINGS_DIMENSIONS = prevDimensions;
    if (prevMaxConcurrency === undefined) delete process.env.EMBEDDINGS_MAX_CONCURRENCY;
    else process.env.EMBEDDINGS_MAX_CONCURRENCY = prevMaxConcurrency;
    if (prevMaxRpm === undefined) delete process.env.EMBEDDINGS_MAX_RPM;
    else process.env.EMBEDDINGS_MAX_RPM = prevMaxRpm;
    if (prevMaxTpm === undefined) delete process.env.EMBEDDINGS_MAX_TPM;
    else process.env.EMBEDDINGS_MAX_TPM = prevMaxTpm;
    if (prevKeyMaxConcurrencies === undefined) delete process.env.EMBEDDINGS_KEY_MAX_CONCURRENCIES;
    else process.env.EMBEDDINGS_KEY_MAX_CONCURRENCIES = prevKeyMaxConcurrencies;
    if (prevKeyMaxRpms === undefined) delete process.env.EMBEDDINGS_KEY_MAX_RPMS;
    else process.env.EMBEDDINGS_KEY_MAX_RPMS = prevKeyMaxRpms;
    if (prevKeyMaxTpms === undefined) delete process.env.EMBEDDINGS_KEY_MAX_TPMS;
    else process.env.EMBEDDINGS_KEY_MAX_TPMS = prevKeyMaxTpms;
    if (prevRateProfile === undefined) delete process.env.EMBEDDINGS_RATE_PROFILE;
    else process.env.EMBEDDINGS_RATE_PROFILE = prevRateProfile;
    if (prevCodeRecallProfile === undefined) delete process.env.CODE_RECALL_PROFILE;
    else process.env.CODE_RECALL_PROFILE = prevCodeRecallProfile;
  }
}

test('resetEmbeddingClient 后应返回新实例', async () => {
  await withEmbeddingEnv(() => {
    resetEmbeddingClient();
    const first = getEmbeddingClient();
    const second = getEmbeddingClient();
    assert.equal(first, second, '未 reset 前应复用同一实例');

    resetEmbeddingClient();
    const third = getEmbeddingClient();
    assert.notEqual(first, third, 'reset 后应重新创建实例');
  });
});

test('resetRateLimitController 后新客户端应获得干净状态', async () => {
  resetRateLimitController();
  const first = new EmbeddingClient({ ...TEST_CONFIG, maxConcurrency: 3 });
  const firstLimiter = (first as any).rateLimitersByKey.get(TEST_CONFIG.apiKey);
  firstLimiter.getStatus = () => ({
    isPaused: false,
    currentConcurrency: 1,
    maxConcurrency: 3,
    activeRequests: 0,
    backoffMs: 20000,
    consecutiveSuccesses: 0,
    rpmAvailable: null,
    tpmAvailable: null,
    estimatedTokensPerRequest: 4000,
    tokenBucketWaits: 0,
    totalTokenBucketWaitMs: 0,
  });
  firstLimiter['currentConcurrency'] = 1;
  firstLimiter['backoffMs'] = 20000;

  const degraded = first.getRateLimiterStatus();
  assert.equal(degraded.currentConcurrency, 1);
  assert.ok(degraded.backoffMs >= 20000);

  resetRateLimitController();
  const second = new EmbeddingClient({ ...TEST_CONFIG, maxConcurrency: 3 });
  const fresh = second.getRateLimiterStatus();

  assert.equal(fresh.currentConcurrency, 3, 'reset 后并发上限应回到新配置值');
  assert.equal(fresh.backoffMs, 5000, 'reset 后退避时间应回到初始值 5s');
});

test('tokenBoundaryRegexCache 应限制最大条目数', () => {
  __resetTokenBoundaryRegexCacheForTest();

  for (let i = 0; i < 1200; i++) {
    getTokenBoundaryRegexForTest(`token_${i}`);
  }

  assert.ok(
    __getTokenBoundaryRegexCacheSizeForTest() <= 1000,
    'regex cache 应有上限，避免长驻进程无限增长',
  );
});

test('VectorStore.close 应探测并调用底层 close/dispose 能力', async () => {
  const store = new VectorStore('vector-store-close-test', 3) as any;
  let dbClosed = 0;
  let tableClosed = 0;

  store.db = {
    close: async () => {
      dbClosed++;
    },
  };
  store.table = {
    close: async () => {
      tableClosed++;
    },
  };

  await store.close();

  assert.equal(dbClosed, 1, '底层连接若提供 close，应被调用');
  assert.equal(tableClosed, 1, '底层表对象若提供 close，应被调用');
  assert.equal(store.db, null);
  assert.equal(store.table, null);
});

test('scan 新轮次应刷新 EmbeddingClient 与 RateLimitController 状态', async () => {
  const { scan } = await import('../../src/scanner/index.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coderecall-scan-reset-'));

  await withEmbeddingEnv(async () => {
    resetEmbeddingClient();
    resetRateLimitController();

    const stale = getEmbeddingClient();
    const staleLimiter = (stale as any).rateLimitersByKey.get(TEST_CONFIG.apiKey);
    staleLimiter['currentConcurrency'] = 1;
    staleLimiter['backoffMs'] = 20000;

    await scan(root, { vectorIndex: true });

    const fresh = getEmbeddingClient();
    assert.notEqual(fresh, stale, 'scan 新轮次应丢弃旧 EmbeddingClient');
    assert.deepEqual(
      fresh.getRateLimiterStatus(),
      {
        isPaused: false,
        currentConcurrency: 2,
        maxConcurrency: 2,
        activeRequests: 0,
        backoffMs: 5000,
        consecutiveSuccesses: 0,
        rpmAvailable: 2000,
        tpmAvailable: 500000,
        estimatedTokensPerRequest: 4000,
        tokenBucketWaits: 0,
        totalTokenBucketWaitMs: 0,
      },
      'scan 新轮次应以干净的速率限制状态启动',
    );
  });

  await fs.rm(root, { recursive: true, force: true });
});

test('logger shutdown 后应释放已打开的日志流', async () => {
  assert.ok(__getOpenLogStreamCountForTest() >= 1, 'logger 初始化后应至少存在一个日志流');
  await __shutdownLoggerForTest();
  assert.equal(__getOpenLogStreamCountForTest(), 0, 'shutdown 后不应残留打开的日志流');
});
