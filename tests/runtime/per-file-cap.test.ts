import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SearchService,
  applyPreRerankPerFileCap,
} from '../../src/search/SearchService.js';
import type { ScoredChunk } from '../../src/search/types.js';

function chunk(filePath: string, chunkIndex: number, score: number): ScoredChunk {
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
      display_code: `line-${chunkIndex}`,
      vector_text: `line-${chunkIndex}`,
      language: 'typescript',
      breadcrumb: `${filePath} > chunk-${chunkIndex}`,
      start_index: 0,
      end_index: 1,
      raw_start: 0,
      raw_end: 1,
      vec_start: 0,
      vec_end: 1,
      _distance: 0,
    },
  };
}

test('per-file cap 应限制单文件进入 rerank 的候选数', () => {
  const input = [
    chunk('src/a.ts', 0, 0.99),
    chunk('src/a.ts', 1, 0.98),
    chunk('src/a.ts', 2, 0.97),
    chunk('src/b.ts', 0, 0.96),
    chunk('src/c.ts', 0, 0.95),
  ];

  const output = applyPreRerankPerFileCap(input, 2);

  assert.deepEqual(
    output.map((item) => `${item.filePath}#${item.chunkIndex}`),
    ['src/a.ts#0', 'src/a.ts#1', 'src/b.ts#0', 'src/c.ts#0'],
  );
});


test('per-file cap <= 0 时应视为不限制', () => {
  const input = [
    chunk('src/a.ts', 0, 0.99),
    chunk('src/a.ts', 1, 0.98),
    chunk('src/b.ts', 0, 0.96),
  ];

  const output = applyPreRerankPerFileCap(input, 0);

  assert.deepEqual(
    output.map((item) => `${item.filePath}#${item.chunkIndex}`),
    ['src/a.ts#0', 'src/a.ts#1', 'src/b.ts#0'],
  );
});

test('buildContextPack 应在 rerank 前应用 per-file cap', async () => {
  const service = new SearchService('per-file-cap-test', '/tmp/project', {
    fusedTopM: 5,
    preRerankPerFileCap: 1,
    enableSmartTopK: false,
  } as any);
  const anyService = service as any;

  const input = [
    chunk('src/a.ts', 0, 0.99),
    chunk('src/a.ts', 1, 0.98),
    chunk('src/a.ts', 2, 0.97),
    chunk('src/b.ts', 0, 0.96),
    chunk('src/c.ts', 0, 0.95),
  ];

  let rerankCandidates: ScoredChunk[] = [];

  anyService.hybridRetrieve = async () => input;
  anyService.rerank = async (_query: string, candidates: ScoredChunk[]) => {
    rerankCandidates = candidates;
    return candidates;
  };
  anyService.expand = async () => [];

  await service.buildContextPack('find chunk');

  assert.deepEqual(
    rerankCandidates.map((item) => `${item.filePath}#${item.chunkIndex}`),
    ['src/a.ts#0', 'src/b.ts#0', 'src/c.ts#0'],
  );
});
