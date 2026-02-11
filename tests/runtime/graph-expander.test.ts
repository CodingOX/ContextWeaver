import assert from 'node:assert/strict';
import test from 'node:test';
import { GraphExpander } from '../../src/search/GraphExpander.js';
import { DEFAULT_CONFIG } from '../../src/search/config.js';
import type { ScoredChunk } from '../../src/search/types.js';

function buildSeed(filePath: string, chunkIndex: number, score = 0.9): ScoredChunk {
  return {
    filePath,
    chunkIndex,
    score,
    source: 'vector',
    record: {
      chunk_id: `${filePath}#h#${chunkIndex}`,
      file_path: filePath,
      file_hash: 'h',
      chunk_index: chunkIndex,
      vector: [0],
      display_code: 'const x = 1;',
      vector_text: 'const x = 1;',
      language: 'typescript',
      breadcrumb: `${filePath} > class A > method run`,
      start_index: 0,
      end_index: 10,
      raw_start: 0,
      raw_end: 10,
      vec_start: 0,
      vec_end: 10,
      _distance: 0,
    },
  };
}

test('neighborHops=0 时不应返回邻居扩展', async () => {
  const expander = new GraphExpander('graph-neighbor-zero', {
    ...DEFAULT_CONFIG,
    neighborHops: 0,
  });

  (expander as any).vectorStore = {
    getFilesChunks: async () =>
      new Map([
        [
          'src/a.ts',
          [
            {
              chunk_id: 'src/a.ts#h#0',
              file_path: 'src/a.ts',
              file_hash: 'h',
              chunk_index: 0,
              vector: [0],
              display_code: 'a',
              vector_text: 'a',
              language: 'typescript',
              breadcrumb: 'src/a.ts > class A > method run',
              start_index: 0,
              end_index: 1,
              raw_start: 0,
              raw_end: 1,
              vec_start: 0,
              vec_end: 1,
            },
            {
              chunk_id: 'src/a.ts#h#1',
              file_path: 'src/a.ts',
              file_hash: 'h',
              chunk_index: 1,
              vector: [0],
              display_code: 'b',
              vector_text: 'b',
              language: 'typescript',
              breadcrumb: 'src/a.ts > class A > method run',
              start_index: 1,
              end_index: 2,
              raw_start: 1,
              raw_end: 2,
              vec_start: 1,
              vec_end: 2,
            },
          ],
        ],
      ]),
  };

  const seedsByFile = new Map<string, ScoredChunk[]>([['src/a.ts', [buildSeed('src/a.ts', 0)]]]);
  const existing = new Set<string>(['src/a.ts#0']);

  const result = await (expander as any).expandNeighbors(seedsByFile, existing);
  assert.deepEqual(result, []);
});

test('breadcrumbExpandLimit=0 时不应返回 breadcrumb 扩展', async () => {
  const expander = new GraphExpander('graph-breadcrumb-zero', {
    ...DEFAULT_CONFIG,
    breadcrumbExpandLimit: 0,
  });

  (expander as any).vectorStore = {
    getFilesChunks: async () =>
      new Map([
        [
          'src/a.ts',
          [
            {
              chunk_id: 'src/a.ts#h#1',
              file_path: 'src/a.ts',
              file_hash: 'h',
              chunk_index: 1,
              vector: [0],
              display_code: 'b',
              vector_text: 'b',
              language: 'typescript',
              breadcrumb: 'src/a.ts > class A > method other',
              start_index: 1,
              end_index: 2,
              raw_start: 1,
              raw_end: 2,
              vec_start: 1,
              vec_end: 2,
            },
          ],
        ],
      ]),
  };

  const result = await (expander as any).expandBreadcrumb(
    [buildSeed('src/a.ts', 0)],
    new Set<string>(),
  );

  assert.deepEqual(result, []);
});

test('importFilesPerSeed=0 时不应触发跨文件扩展结果', async () => {
  const expander = new GraphExpander('graph-import-zero', {
    ...DEFAULT_CONFIG,
    importFilesPerSeed: 0,
    chunksPerImportFile: 2,
  });

  (expander as any).resolvers = [
    {
      supports: () => true,
      extract: () => ['import x from "./dep"'],
      resolve: () => 'src/dep.ts',
    },
  ];

  (expander as any).db = {
    prepare: () => ({
      get: () => ({ content: 'import x from "./dep";' }),
    }),
  };

  let getFileChunksCalled = 0;
  (expander as any).vectorStore = {
    getFileChunks: async () => {
      getFileChunksCalled += 1;
      return [];
    },
  };

  (expander as any).allFilePaths = new Set<string>(['src/a.ts', 'src/dep.ts']);

  const result = await (expander as any).expandImports(
    [buildSeed('src/a.ts', 0)],
    new Set<string>(),
    new Set<string>(['dep']),
  );

  assert.deepEqual(result, []);
  assert.equal(getFileChunksCalled, 0, 'per-file limit 为 0 时不应读取导入文件 chunks');
});
