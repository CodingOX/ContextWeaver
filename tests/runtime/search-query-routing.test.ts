import assert from 'node:assert/strict';
import test from 'node:test';
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
