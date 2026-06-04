import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import type { ProcessedChunk } from '../../src/chunking/types.js';
import {
  batchUpsert,
  closeDb,
  type FileMeta,
  getFilesNeedingVectorIndex,
  initDb,
} from '../../src/db/index.js';
import { closeAllIndexers, getIndexer } from '../../src/indexer/index.js';
import type { ProcessResult } from '../../src/scanner/processor.js';
import { getProjectDataDir } from '../../src/utils/paths.js';
import { closeAllVectorStores } from '../../src/vectorStore/index.js';

const TEST_PROJECT = 'test-batch-index-resilience';
const TEST_DIR = getProjectDataDir(TEST_PROJECT);

function makeChunk(index: number, filePath: string): ProcessedChunk {
  return {
    displayCode: `// chunk ${index} from ${filePath}`,
    vectorText: `vector text ${index} for embedding`,
    nwsSize: 50,
    metadata: {
      filePath,
      language: 'typescript',
      contextPath: [filePath],
      startIndex: index * 100,
      endIndex: (index + 1) * 100,
      rawSpan: { start: index * 100, end: (index + 1) * 100 },
      vectorSpan: { start: index * 100, end: (index + 1) * 100 },
    },
  };
}

test(
  '真实 LanceDB 冒烟: 分批索引成功后 files 元数据收敛',
  { skip: !process.env.EMBEDDINGS_API_KEY && !process.env.EMBEDDINGS_API_KEYS },
  async () => {
    // 此测试需要真实 embedding API，默认 skip
    // 设置环境变量后运行: EMBEDDINGS_API_KEY=xxx tsx tests/runtime/batch-index-resilience-integration.test.ts

    const db = initDb(TEST_PROJECT);
    const indexer = await getIndexer(TEST_PROJECT);

    // 创建 60 个文件，每个 10 chunks = 600 chunks → 2 批 (BATCH_CHUNKS=400)
    const results: ProcessResult[] = [];
    const files: FileMeta[] = [];
    for (let i = 0; i < 60; i++) {
      const filePath = `src/file-${String(i).padStart(3, '0')}.ts`;
      const hash = `hash-${String(i).padStart(3, '0')}`;
      const chunks: ProcessedChunk[] = [];
      for (let j = 0; j < 10; j++) {
        chunks.push(makeChunk(j, filePath));
      }
      files.push({
        path: filePath,
        hash,
        mtime: Date.now(),
        size: 100,
        content: '// mock content',
        language: 'typescript',
        vectorIndexHash: null,
      });
      results.push({
        absPath: `/tmp/${filePath}`,
        relPath: filePath,
        hash,
        status: 'added' as const,
        content: '// mock content',
        chunks,
        language: 'typescript',
        mtime: Date.now(),
        size: 100,
      });
    }

    try {
      batchUpsert(db, files);

      const stats = await indexer.indexFiles(db, results);
      assert.equal(stats.errors, 0);
      assert.equal(stats.indexed, 60);

      // 验证: 成功索引的文件在后续 scan 中被标记为 unchanged
      const needingIndex = getFilesNeedingVectorIndex(db);
      assert.equal(needingIndex.length, 0, '所有文件应已标记为向量索引完成');
    } finally {
      closeDb(db);
      closeAllIndexers();
      await closeAllVectorStores();
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  },
);
