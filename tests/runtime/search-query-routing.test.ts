import assert from 'node:assert/strict';
import test from 'node:test';
import { initDb } from '../../src/db/index.js';
import { batchUpsertFileFts, initFilesFts } from '../../src/search/fts.js';
import { SearchService } from '../../src/search/SearchService.js';
import type { ScoredChunk } from '../../src/search/types.js';

type RankedChunk = ScoredChunk & { _rank?: number };

interface SearchServiceHarness {
  buildContextPack: SearchService['buildContextPack'];
  close: SearchService['close'];
  hybridRetrieve: (vectorQuery: string, lexicalQuery: string) => Promise<ScoredChunk[]>;
  rerank: (rerankQuery: string, items: ScoredChunk[]) => Promise<ScoredChunk[]>;
  applySmartCutoff: (items: ScoredChunk[]) => ScoredChunk[];
  expand: () => Promise<ScoredChunk[]>;
  fuse: (vectorResults: RankedChunk[], lexicalResults: RankedChunk[]) => ScoredChunk[];
  db: { close: () => void } | null;
  vectorStore: { close: () => Promise<void> } | null;
  indexer: unknown | null;
}

const CANDIDATE: ScoredChunk = {
  filePath: 'src/demo.ts',
  chunkIndex: 0,
  score: 0.88,
  source: 'vector',
  record: {
    chunk_id: 'src/demo.ts#hash#0',
    file_path: 'src/demo.ts',
    file_hash: 'hash',
    chunk_index: 0,
    vector: [0],
    display_code: 'export const demo = 1;',
    vector_text: 'demo',
    language: 'typescript',
    breadcrumb: 'src/demo.ts > const demo',
    start_index: 0,
    end_index: 20,
    raw_start: 0,
    raw_end: 20,
    vec_start: 0,
    vec_end: 20,
    _distance: 0,
  },
};

test('SearchService 应按通道路由 query', async () => {
  const service = new SearchService('search-query-routing-test', '/tmp/project');
  const harness = service as unknown as SearchServiceHarness;

  let capturedVector = '';
  let capturedLexical = '';
  let capturedRerank = '';

  harness.hybridRetrieve = async (vectorQuery: string, lexicalQuery: string) => {
    capturedVector = vectorQuery;
    capturedLexical = lexicalQuery;
    return [CANDIDATE];
  };
  harness.rerank = async (rerankQuery: string, items: ScoredChunk[]) => {
    capturedRerank = rerankQuery;
    return items;
  };
  harness.applySmartCutoff = (items: ScoredChunk[]) => items;
  harness.expand = async () => [];

  await service.buildContextPack('fallback query', {
    vectorQuery: 'vector only',
    lexicalQuery: 'lexical only',
    rerankQuery: 'rerank full',
  });

  assert.equal(capturedVector, 'vector only');
  assert.equal(capturedLexical, 'lexical only');
  assert.equal(capturedRerank, 'rerank full');
});

test('未传 channels 时应保持旧路由行为', async () => {
  const service = new SearchService('search-query-routing-default-test', '/tmp/project');
  const harness = service as unknown as SearchServiceHarness;

  let capturedVector = '';
  let capturedLexical = '';
  let capturedRerank = '';

  harness.hybridRetrieve = async (vectorQuery: string, lexicalQuery: string) => {
    capturedVector = vectorQuery;
    capturedLexical = lexicalQuery;
    return [CANDIDATE];
  };
  harness.rerank = async (rerankQuery: string, items: ScoredChunk[]) => {
    capturedRerank = rerankQuery;
    return items;
  };
  harness.applySmartCutoff = (items: ScoredChunk[]) => items;
  harness.expand = async () => [];

  await service.buildContextPack('legacy query');

  assert.equal(capturedVector, 'legacy query');
  assert.equal(capturedLexical, 'legacy query');
  assert.equal(capturedRerank, 'legacy query');
});

test('RRF 双路命中时应保留 both 来源', () => {
  const service = new SearchService(
    'search-source-both-test',
    '/tmp/project',
  ) as unknown as SearchServiceHarness;

  const fused = service.fuse(
    [{ ...CANDIDATE, source: 'vector', _rank: 0 }],
    [{ ...CANDIDATE, source: 'lexical', _rank: 0 }],
  );

  assert.equal(fused.length, 1);
  assert.equal(fused[0].source, 'both');
});

test('SearchService.close 应释放已初始化资源', async () => {
  const service = new SearchService(
    'search-close-test',
    '/tmp/project',
  ) as unknown as SearchServiceHarness;
  let dbClosed = false;
  let vectorClosed = false;

  service.db = {
    close: () => {
      dbClosed = true;
    },
  };
  service.vectorStore = {
    close: async () => {
      vectorClosed = true;
    },
  };

  await service.close();

  assert.equal(dbClosed, true);
  assert.equal(vectorClosed, true);
  assert.equal(service.db, null);
  assert.equal(service.vectorStore, null);
  assert.equal(service.indexer, null);
});

test('files_fts 降级路径应批量获取 chunks，避免逐文件查询', async () => {
  const projectId = `search-files-fts-batch-test-${Date.now()}`;
  const db = initDb(projectId);
  const service = new SearchService(
    projectId,
    '/tmp/project',
  ) as unknown as SearchServiceHarness & {
    config: { ftsTopKFiles: number; lexTotalChunks: number; lexChunksPerFile: number };
    lexicalRetrieveFromFilesFts: (query: string, languageFilter?: string[]) => Promise<ScoredChunk[]>;
  };

  let batchCalls = 0;
  let singleCalls = 0;

  initFilesFts(db);
  batchUpsertFileFts(db, [
    { path: 'src/a.ts', content: 'match token' },
    { path: 'src/b.ts', content: 'match token' },
  ]);

  service.db = db;
  service.vectorStore = {
    close: async () => {},
    getFilesChunks: async (paths: string[]) => {
      batchCalls++;
      return new Map(
        paths.map((filePath, idx) => [
          filePath,
          [
            {
              chunk_id: `${filePath}#hash#0`,
              file_path: filePath,
              file_hash: 'hash',
              chunk_index: 0,
              vector: [0],
              display_code: idx === 0 ? 'match token' : 'other token',
              vector_text: 'token',
              language: 'typescript',
              breadcrumb: `${filePath} > const demo`,
              start_index: 0,
              end_index: 10,
              raw_start: 0,
              raw_end: 10,
              vec_start: 0,
              vec_end: 10,
            },
          ],
        ]),
      );
    },
    getFileChunks: async () => {
      singleCalls++;
      return [];
    },
  } as unknown as { close: () => Promise<void> };

  service.config.ftsTopKFiles = 10;
  service.config.lexTotalChunks = 10;
  service.config.lexChunksPerFile = 1;

  const results = await service.lexicalRetrieveFromFilesFts('match token');
  assert.equal(batchCalls, 1);
  assert.equal(singleCalls, 0);
  assert.equal(results.length, 2);
  assert.equal(results[0].filePath, 'src/a.ts');
  assert.equal(results[1].filePath, 'src/b.ts');
});
