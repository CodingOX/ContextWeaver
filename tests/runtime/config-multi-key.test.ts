import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkEmbeddingEnv,
  checkRerankerEnv,
  getEmbeddingConfig,
  getRerankerConfig,
} from '../../src/config.js';

const MANAGED_ENV_KEYS = [
  'EMBEDDINGS_API_KEY',
  'EMBEDDINGS_API_KEYS',
  'EMBEDDINGS_BASE_URL',
  'EMBEDDINGS_MODEL',
  'RERANK_API_KEY',
  'RERANK_API_KEYS',
  'RERANK_BASE_URL',
  'RERANK_MODEL',
] as const;

function runWithEnv(overrides: Partial<Record<(typeof MANAGED_ENV_KEYS)[number], string>>, fn: () => void): void {
  const snapshot = new Map<string, string | undefined>();
  for (const key of MANAGED_ENV_KEYS) {
    snapshot.set(key, process.env[key]);
    delete process.env[key];
  }

  for (const [key, value] of Object.entries(overrides)) {
    process.env[key] = value;
  }

  try {
    fn();
  } finally {
    for (const key of MANAGED_ENV_KEYS) {
      const prev = snapshot.get(key);
      if (prev === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev;
      }
    }
  }
}

test('应解析 EMBEDDINGS_API_KEYS 并保留首项作为 apiKey', { concurrency: false }, () => {
  runWithEnv(
    {
      EMBEDDINGS_API_KEYS: ' key-a , key-b,key-c ',
      EMBEDDINGS_BASE_URL: 'https://example.com/embeddings',
      EMBEDDINGS_MODEL: 'text-embedding-model',
    },
    () => {
      const config = getEmbeddingConfig();

      assert.equal(config.apiKey, 'key-a');
      assert.deepEqual(config.apiKeys, ['key-a', 'key-b', 'key-c']);
      assert.equal(checkEmbeddingEnv().isValid, true);
    },
  );
});

test('应兼容旧变量并映射到 apiKeys', { concurrency: false }, () => {
  runWithEnv(
    {
      EMBEDDINGS_API_KEY: 'legacy-embedding-key',
      EMBEDDINGS_BASE_URL: 'https://example.com/embeddings',
      EMBEDDINGS_MODEL: 'text-embedding-model',
      RERANK_API_KEY: 'legacy-rerank-key',
      RERANK_BASE_URL: 'https://example.com/rerank',
      RERANK_MODEL: 'rerank-model',
    },
    () => {
      const embeddingConfig = getEmbeddingConfig();
      const rerankerConfig = getRerankerConfig();

      assert.equal(embeddingConfig.apiKey, 'legacy-embedding-key');
      assert.deepEqual(embeddingConfig.apiKeys, ['legacy-embedding-key']);
      assert.equal(rerankerConfig.apiKey, 'legacy-rerank-key');
      assert.deepEqual(rerankerConfig.apiKeys, ['legacy-rerank-key']);
      assert.equal(checkEmbeddingEnv().isValid, true);
      assert.equal(checkRerankerEnv().isValid, true);
    },
  );
});

test('应解析 RERANK_API_KEYS 并保留首项作为 apiKey', { concurrency: false }, () => {
  runWithEnv(
    {
      RERANK_API_KEYS: ' rk-1 , rk-2,rk-3 ',
      RERANK_BASE_URL: 'https://example.com/rerank',
      RERANK_MODEL: 'rerank-model',
    },
    () => {
      const config = getRerankerConfig();

      assert.equal(config.apiKey, 'rk-1');
      assert.deepEqual(config.apiKeys, ['rk-1', 'rk-2', 'rk-3']);
      assert.equal(checkRerankerEnv().isValid, true);
    },
  );
});

test('多 key 与单 key 同时存在时应去重并保持多 key 顺序优先', { concurrency: false }, () => {
  runWithEnv(
    {
      EMBEDDINGS_API_KEYS: 'k2,k1,k2',
      EMBEDDINGS_API_KEY: 'k1',
      EMBEDDINGS_BASE_URL: 'https://example.com/embeddings',
      EMBEDDINGS_MODEL: 'text-embedding-model',
      RERANK_API_KEYS: 'r2,r1,r2',
      RERANK_API_KEY: 'r1',
      RERANK_BASE_URL: 'https://example.com/rerank',
      RERANK_MODEL: 'rerank-model',
    },
    () => {
      const embeddingConfig = getEmbeddingConfig();
      const rerankerConfig = getRerankerConfig();

      assert.deepEqual(embeddingConfig.apiKeys, ['k2', 'k1']);
      assert.equal(embeddingConfig.apiKey, 'k2');
      assert.deepEqual(rerankerConfig.apiKeys, ['r2', 'r1']);
      assert.equal(rerankerConfig.apiKey, 'r2');
    },
  );
});

test('应过滤占位符与空白项，且单 key 可作为兜底', { concurrency: false }, () => {
  runWithEnv(
    {
      EMBEDDINGS_API_KEYS: ' , your-api-key-here, key-valid-1, , key-valid-2 ',
      EMBEDDINGS_BASE_URL: 'https://example.com/embeddings',
      EMBEDDINGS_MODEL: 'text-embedding-model',
      RERANK_API_KEYS: ' ,your-api-key-here, ',
      RERANK_API_KEY: 'legacy-rerank-fallback',
      RERANK_BASE_URL: 'https://example.com/rerank',
      RERANK_MODEL: 'rerank-model',
    },
    () => {
      const embeddingConfig = getEmbeddingConfig();
      const rerankerConfig = getRerankerConfig();

      assert.deepEqual(embeddingConfig.apiKeys, ['key-valid-1', 'key-valid-2']);
      assert.equal(embeddingConfig.apiKey, 'key-valid-1');
      assert.deepEqual(rerankerConfig.apiKeys, ['legacy-rerank-fallback']);
      assert.equal(rerankerConfig.apiKey, 'legacy-rerank-fallback');
      assert.equal(checkEmbeddingEnv().isValid, true);
      assert.equal(checkRerankerEnv().isValid, true);
    },
  );
});

test('缺失有效 key 时应报错并返回缺失项', { concurrency: false }, () => {
  runWithEnv(
    {
      EMBEDDINGS_API_KEYS: ' ,your-api-key-here, ',
      EMBEDDINGS_BASE_URL: 'https://example.com/embeddings',
      EMBEDDINGS_MODEL: 'text-embedding-model',
      RERANK_API_KEY: 'your-api-key-here',
      RERANK_API_KEYS: ' , ',
      RERANK_BASE_URL: 'https://example.com/rerank',
      RERANK_MODEL: 'rerank-model',
    },
    () => {
      const embeddingCheck = checkEmbeddingEnv();
      const rerankerCheck = checkRerankerEnv();

      assert.equal(embeddingCheck.isValid, false);
      assert.deepEqual(embeddingCheck.missingVars, ['EMBEDDINGS_API_KEY 或 EMBEDDINGS_API_KEYS']);
      assert.equal(rerankerCheck.isValid, false);
      assert.deepEqual(rerankerCheck.missingVars, ['RERANK_API_KEY 或 RERANK_API_KEYS']);

      assert.throws(
        () => getEmbeddingConfig(),
        /EMBEDDINGS_API_KEY 或 EMBEDDINGS_API_KEYS 环境变量未设置/,
      );
      assert.throws(() => getRerankerConfig(), /RERANK_API_KEY 或 RERANK_API_KEYS 环境变量未设置/);
    },
  );
});
