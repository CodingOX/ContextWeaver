import assert from 'node:assert/strict';
import test from 'node:test';
import { SearchService } from '../../src/search/SearchService.js';
import type { ScoredChunk } from '../../src/search/types.js';
import { logger } from '../../src/utils/logger.js';

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

test('rerank 失败时应降级到融合结果继续返回 seeds', async () => {
  const service = new SearchService('search-rerank-fallback-test', '/tmp/project');
  const anyService = service as any;

  anyService.hybridRetrieve = async () => [CANDIDATE];
  anyService.rerank = async () => {
    throw new Error('rerank down');
  };
  anyService.applySmartCutoff = (items: ScoredChunk[]) => items;
  anyService.expand = async () => [];

  const originalWarn = logger.warn;
  let warned = false;
  (logger as any).warn = (..._args: unknown[]) => {
    warned = true;
  };

  try {
    const pack = await service.buildContextPack('find demo');

    assert.equal(pack.seeds.length, 1);
    assert.equal(pack.seeds[0].filePath, 'src/demo.ts');
    assert.equal(warned, true);
  } finally {
    (logger as any).warn = originalWarn;
  }
});
