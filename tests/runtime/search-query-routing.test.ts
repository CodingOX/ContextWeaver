import assert from 'node:assert/strict';
import test from 'node:test';
import { SearchService } from '../../src/search/SearchService.js';
import type { ScoredChunk } from '../../src/search/types.js';

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
  const anyService = service as any;

  let capturedVector = '';
  let capturedLexical = '';
  let capturedRerank = '';

  anyService.hybridRetrieve = async (vectorQuery: string, lexicalQuery: string) => {
    capturedVector = vectorQuery;
    capturedLexical = lexicalQuery;
    return [CANDIDATE];
  };
  anyService.rerank = async (rerankQuery: string, items: ScoredChunk[]) => {
    capturedRerank = rerankQuery;
    return items;
  };
  anyService.applySmartCutoff = (items: ScoredChunk[]) => items;
  anyService.expand = async () => [];

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
  const anyService = service as any;

  let capturedVector = '';
  let capturedLexical = '';
  let capturedRerank = '';

  anyService.hybridRetrieve = async (vectorQuery: string, lexicalQuery: string) => {
    capturedVector = vectorQuery;
    capturedLexical = lexicalQuery;
    return [CANDIDATE];
  };
  anyService.rerank = async (rerankQuery: string, items: ScoredChunk[]) => {
    capturedRerank = rerankQuery;
    return items;
  };
  anyService.applySmartCutoff = (items: ScoredChunk[]) => items;
  anyService.expand = async () => [];

  await service.buildContextPack('legacy query');

  assert.equal(capturedVector, 'legacy query');
  assert.equal(capturedLexical, 'legacy query');
  assert.equal(capturedRerank, 'legacy query');
});
