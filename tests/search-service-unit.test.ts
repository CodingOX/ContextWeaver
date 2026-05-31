import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('searchCodebase 缺少环境变量时会创建默认 .env 并抛出 MissingEnvError', async () => {
  const originalEmbedding = process.env.EMBEDDINGS_API_KEY;
  const originalEmbeddingBaseUrl = process.env.EMBEDDINGS_BASE_URL;
  const originalEmbeddingModel = process.env.EMBEDDINGS_MODEL;
  const originalRerank = process.env.RERANK_API_KEY;
  const originalRerankBaseUrl = process.env.RERANK_BASE_URL;
  const originalRerankModel = process.env.RERANK_MODEL;
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextweaver-search-'));
  const repoPath = path.join(baseDir, 'repo');
  fs.mkdirSync(repoPath, { recursive: true });

  delete process.env.EMBEDDINGS_API_KEY;
  delete process.env.EMBEDDINGS_BASE_URL;
  delete process.env.EMBEDDINGS_MODEL;
  delete process.env.RERANK_API_KEY;
  delete process.env.RERANK_BASE_URL;
  delete process.env.RERANK_MODEL;

  try {
    const { searchCodebase, MissingEnvError } = await import('../src/app/searchCodebase.js');

    await assert.rejects(
      () =>
        searchCodebase({
          repoPath,
          query: 'trace login flow',
          baseDir,
        }),
      (error: unknown) =>
        error instanceof MissingEnvError &&
        error.name === 'MissingEnvError' &&
        Array.isArray(error.missingVars) &&
        error.missingVars.length > 0,
    );

    assert.equal(fs.existsSync(path.join(baseDir, '.env')), true);
  } finally {
    if (originalEmbedding === undefined) delete process.env.EMBEDDINGS_API_KEY;
    else process.env.EMBEDDINGS_API_KEY = originalEmbedding;

    if (originalEmbeddingBaseUrl === undefined) delete process.env.EMBEDDINGS_BASE_URL;
    else process.env.EMBEDDINGS_BASE_URL = originalEmbeddingBaseUrl;

    if (originalEmbeddingModel === undefined) delete process.env.EMBEDDINGS_MODEL;
    else process.env.EMBEDDINGS_MODEL = originalEmbeddingModel;

    if (originalRerank === undefined) delete process.env.RERANK_API_KEY;
    else process.env.RERANK_API_KEY = originalRerank;

    if (originalRerankBaseUrl === undefined) delete process.env.RERANK_BASE_URL;
    else process.env.RERANK_BASE_URL = originalRerankBaseUrl;

    if (originalRerankModel === undefined) delete process.env.RERANK_MODEL;
    else process.env.RERANK_MODEL = originalRerankModel;
  }
});

test('handleCodebaseRetrieval 缺环境变量时返回友好的 MCP 响应', async () => {
  const originalEmbedding = process.env.EMBEDDINGS_API_KEY;
  const originalEmbeddingBaseUrl = process.env.EMBEDDINGS_BASE_URL;
  const originalEmbeddingModel = process.env.EMBEDDINGS_MODEL;
  const originalRerank = process.env.RERANK_API_KEY;
  const originalRerankBaseUrl = process.env.RERANK_BASE_URL;
  const originalRerankModel = process.env.RERANK_MODEL;
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextweaver-mcp-'));
  const repoPath = path.join(baseDir, 'repo');
  fs.mkdirSync(repoPath, { recursive: true });
  const osMutable = os as typeof os & { homedir: () => string };
  const originalHomedir = osMutable.homedir;
  osMutable.homedir = () => baseDir;

  delete process.env.EMBEDDINGS_API_KEY;
  delete process.env.EMBEDDINGS_BASE_URL;
  delete process.env.EMBEDDINGS_MODEL;
  delete process.env.RERANK_API_KEY;
  delete process.env.RERANK_BASE_URL;
  delete process.env.RERANK_MODEL;

  try {
    const { handleCodebaseRetrieval } = await import('../src/mcp/tools/codebaseRetrieval.js');

    const response = await handleCodebaseRetrieval({
      repo_path: repoPath,
      information_request: 'trace login flow',
    });

    assert.equal(response.content.length, 1);
    assert.equal(response.content[0]?.type, 'text');
    assert.match(response.content[0]?.text ?? '', /配置缺失/);
    assert.match(response.content[0]?.text ?? '', /EMBEDDINGS_API_KEY/);
    assert.match(response.content[0]?.text ?? '', /RERANK_API_KEY/);
    assert.match(
      response.content[0]?.text ?? '',
      new RegExp(path.join(baseDir, '.contextweaver', '.env').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
    assert.equal(fs.existsSync(path.join(baseDir, '.contextweaver', '.env')), true);
  } finally {
    osMutable.homedir = originalHomedir;

    if (originalEmbedding === undefined) delete process.env.EMBEDDINGS_API_KEY;
    else process.env.EMBEDDINGS_API_KEY = originalEmbedding;

    if (originalEmbeddingBaseUrl === undefined) delete process.env.EMBEDDINGS_BASE_URL;
    else process.env.EMBEDDINGS_BASE_URL = originalEmbeddingBaseUrl;

    if (originalEmbeddingModel === undefined) delete process.env.EMBEDDINGS_MODEL;
    else process.env.EMBEDDINGS_MODEL = originalEmbeddingModel;

    if (originalRerank === undefined) delete process.env.RERANK_API_KEY;
    else process.env.RERANK_API_KEY = originalRerank;

    if (originalRerankBaseUrl === undefined) delete process.env.RERANK_BASE_URL;
    else process.env.RERANK_BASE_URL = originalRerankBaseUrl;

    if (originalRerankModel === undefined) delete process.env.RERANK_MODEL;
    else process.env.RERANK_MODEL = originalRerankModel;
  }
});

test('当前 MCP 工具注册中心只暴露 MCP 适配层入口', async () => {
  const tools = await import('../src/mcp/tools/index.js');

  assert.equal(
    typeof tools.handleCodebaseRetrieval,
    'function',
    '当前工具注册中心应暴露 MCP 适配层入口',
  );
  assert.equal(
    'searchCodebase' in tools,
    false,
    '当前工具注册中心不应暴露共享 searchCodebase 入口',
  );
});

test('ensureDefaultEnvFile 会创建默认 .env', async () => {
  const { ensureDefaultEnvFile } = await import('../src/app/ensureDefaultEnvFile.js');

  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextweaver-env-'));
  const result = await ensureDefaultEnvFile(baseDir);
  const envFile = path.join(baseDir, '.env');

  assert.equal(result.created, true);
  assert.equal(result.envFile, envFile);
  assert.equal(fs.existsSync(envFile), true);

  const content = fs.readFileSync(envFile, 'utf-8');
  assert.match(content, /EMBEDDINGS_API_KEY=your-api-key-here/);
  assert.match(content, /RERANK_API_KEY=your-api-key-here/);
});

test('ensureIndexed 首次扫描时返回 wasIndexed=false', async () => {
  const { ensureIndexed } = await import('../src/app/ensureIndexed.js');

  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextweaver-index-'));
  const projectId = 'project-123456';
  const repoPath = path.join(baseDir, 'repo');
  fs.mkdirSync(repoPath, { recursive: true });

  const result = await ensureIndexed(repoPath, projectId, {
    baseDir,
    withLock: async (_projectId, _operation, fn) => fn(),
    scan: async () => {
      const projectDir = path.join(baseDir, projectId);
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'index.db'), 'created-by-test');

      return {
        totalFiles: 1,
        added: 1,
        modified: 0,
        unchanged: 0,
        deleted: 0,
        skipped: 0,
        errors: 0,
        vectorIndex: {
          indexed: 1,
          deleted: 0,
          errors: 0,
        },
      };
    },
  }, undefined);

  assert.equal(result.wasIndexed, false);
  assert.equal(result.stats.totalFiles, 1);
});
