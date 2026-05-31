import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

import type { ContextPack } from '../src/search/types.js';

test('CLI 与 MCP 使用同一份文本格式化器', async () => {
  const { formatSearchText } = await import('../src/app/formatSearchText.js');
  const { formatMcpResponse } = await import('../src/mcp/tools/codebaseRetrieval.js');
  const { runSearchCommand } = await import('../src/index.js');

  const pack = {
    query: 'trace login flow',
    seeds: [
      {
        filePath: 'src/auth/login.ts',
        chunkIndex: 0,
        score: 0.99,
        source: 'vector',
        record: {
          chunk_id: 'src/auth/login.ts#hash#0',
          file_path: 'src/auth/login.ts',
          file_hash: 'hash',
          chunk_index: 0,
          vector: [0.1, 0.2],
          display_code: 'export function login() {}',
          vector_text: 'login flow',
          language: 'typescript',
          breadcrumb: 'Auth > Login',
          start_index: 0,
          end_index: 18,
          raw_start: 0,
          raw_end: 18,
          vec_start: 0,
          vec_end: 18,
          _distance: 0,
        },
        _distance: 0,
      },
    ],
    expanded: [],
    files: [
      {
        filePath: 'src/auth/login.ts',
        segments: [
          {
            filePath: 'src/auth/login.ts',
            rawStart: 0,
            rawEnd: 18,
            startLine: 1,
            endLine: 3,
            score: 0.99,
            breadcrumb: 'Auth > Login',
            text: 'export function login() {\n  return true;\n}',
          },
        ],
      },
    ],
    debug: {
      wVec: 0.7,
      wLex: 0.3,
      timingMs: {},
    },
  } satisfies ContextPack;

  const formattedText = formatSearchText(pack);
  const mcpText = formatMcpResponse(pack).content[0]?.text;

  assert.equal(mcpText, formattedText, 'MCP 输出必须直接复用共享格式化器');

  const written: string[] = [];
  const cliText = await runSearchCommand(
    {
      repoPath: '/repo',
      informationRequest: 'trace login flow',
      technicalTerms: 'login',
      zen: false,
    },
    {
      search: async () =>
        ({
          projectId: 'project-123',
          query: 'trace login flow login',
          contextPack: pack,
        }),
      write: (text) => {
        written.push(text);
      },
    },
  );

  assert.equal(cliText, formattedText, 'CLI 返回值必须与共享格式化器一致');
  assert.deepEqual(written, [formattedText], 'CLI 输出必须直接写入共享格式化结果');
});

test('search 命令在缺少查询时会报错', async () => {
  const { runSearchCommand } = await import('../src/index.js');

  await assert.rejects(
    () =>
      runSearchCommand({
        repoPath: '/repo',
        zen: false,
      }),
    /缺少 --query 或 --information-request/,
  );
});

test('search 命令支持 query 别名并可输出 JSON', async () => {
  const { runSearchCommand } = await import('../src/index.js');

  const written: string[] = [];
  const jsonText = await runSearchCommand(
    {
      repoPath: '/repo',
      query: 'trace login flow',
      zen: false,
      json: true,
    },
    {
      search: async () =>
        ({
          projectId: 'project-123',
          query: 'trace login flow',
          contextPack: {
            query: 'trace login flow',
            seeds: [],
            expanded: [],
            files: [],
            debug: {
              wVec: 0.7,
              wLex: 0.3,
              timingMs: {},
            },
          },
        }),
      write: (text) => {
        written.push(text);
      },
    },
  );

  const payload = JSON.parse(jsonText) as {
    version: string;
    success: boolean;
    projectId: string;
    query: string;
    seeds: unknown[];
    expanded: unknown[];
    files: unknown[];
  };

  assert.equal(payload.success, true);
  assert.equal(payload.projectId, 'project-123');
  assert.equal(payload.query, 'trace login flow');
  assert.deepEqual(payload.seeds, []);
  assert.deepEqual(payload.expanded, []);
  assert.deepEqual(payload.files, []);
  assert.deepEqual(written, [jsonText]);
});

test('search 命令在 JSON 模式下遇到 MissingEnvError 时输出可解析 JSON', async () => {
  const { MissingEnvError } = await import('../src/app/searchCodebase.js');
  const { runSearchCommand } = await import('../src/index.js');

  const written: string[] = [];
  const jsonText = await runSearchCommand(
    {
      repoPath: '/repo',
      query: 'trace login flow',
      zen: false,
      json: true,
    },
    {
      search: async () => {
        throw new MissingEnvError(['EMBEDDINGS_API_KEY', 'RERANK_API_KEY']);
      },
      write: (text) => {
        written.push(text);
      },
    },
  );

  const payload = JSON.parse(jsonText) as {
    version: string;
    success: boolean;
    query: string;
    error: {
      name: string;
      message: string;
      missingVars: string[];
    };
  };

  assert.equal(payload.success, false);
  assert.equal(payload.query, 'trace login flow');
  assert.equal(payload.error.name, 'MissingEnvError');
  assert.deepEqual(payload.error.missingVars, ['EMBEDDINGS_API_KEY', 'RERANK_API_KEY']);
  assert.deepEqual(written, [jsonText]);
});

test('search JSON 错误响应会保留 technicalTerms 拼接后的完整查询', async () => {
  const { MissingEnvError } = await import('../src/app/searchCodebase.js');
  const { runSearchCommand } = await import('../src/index.js');

  const jsonText = await runSearchCommand(
    {
      repoPath: '/repo',
      query: 'trace login flow',
      technicalTerms: 'AuthService,login',
      zen: false,
      json: true,
    },
    {
      search: async () => {
        throw new MissingEnvError(['EMBEDDINGS_API_KEY']);
      },
      write: () => {},
    },
  );

  const payload = JSON.parse(jsonText) as {
    success: boolean;
    query: string;
    error: {
      missingVars: string[];
    };
  };

  assert.equal(payload.success, false);
  assert.equal(payload.query, 'trace login flow AuthService login');
  assert.deepEqual(payload.error.missingVars, ['EMBEDDINGS_API_KEY']);
});

test('search 命令会把 codeOnly 传递给公共搜索服务', async () => {
  const { runSearchCommand } = await import('../src/index.js');

  let capturedCodeOnly: boolean | undefined;
  await runSearchCommand(
    {
      repoPath: '/repo',
      query: 'trace login flow',
      zen: false,
      codeOnly: true,
    },
    {
      search: async (input) => {
        capturedCodeOnly = input.codeOnly;
        return {
          projectId: 'project-123',
          query: input.query,
          contextPack: {
            query: input.query,
            seeds: [],
            expanded: [],
            files: [],
            debug: {
              wVec: 0.7,
              wLex: 0.3,
              timingMs: {},
            },
          },
        };
      },
      write: () => {},
    },
  );

  assert.equal(capturedCodeOnly, true);
});

test('CLI smoke: 真实命令行入口可解析 query/json/code-only 并输出 JSON 错误结果', async () => {
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        'pnpm',
        [
          'exec',
          'tsx',
          'src/index.ts',
          'search',
          '--query',
          'trace login flow',
          '--technical-terms',
          'AuthService,login',
          '--json',
          '--code-only',
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            EMBEDDINGS_API_KEY: '',
            EMBEDDINGS_BASE_URL: '',
            EMBEDDINGS_MODEL: '',
            RERANK_API_KEY: '',
            RERANK_BASE_URL: '',
            RERANK_MODEL: '',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );

      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('CLI smoke 执行超时（30s）'));
      }, 30_000);

      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    },
  );

  assert.equal(result.code, 0);
  assert.match(result.stderr, /开始执行代码库搜索编排/);

  const payload = JSON.parse(result.stdout) as {
    success: boolean;
    query: string;
    error: {
      name: string;
      missingVars: string[];
    };
  };

  assert.equal(payload.success, false);
  assert.equal(payload.query, 'trace login flow AuthService login');
  assert.equal(payload.error.name, 'MissingEnvError');
  assert.ok(payload.error.missingVars.length > 0);
});
