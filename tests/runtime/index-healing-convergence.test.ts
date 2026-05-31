import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  batchUpsert,
  closeDb,
  getFilesNeedingVectorIndex,
  initDb,
  type FileMeta,
} from '../../src/db/index.js';
import { closeAllIndexers, getIndexer } from '../../src/indexer/index.js';
import type { ProcessResult } from '../../src/scanner/processor.js';
import { closeAllVectorStores } from '../../src/vectorStore/index.js';

function projectDir(projectId: string): string {
  return path.join(os.homedir(), '.contextweaver', projectId);
}

test('无 chunk 文件应在索引后收敛，避免重复进入 healing 集合', async () => {
  const projectId = `healing-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const db = initDb(projectId);
  const relPath = 'src/no-chunk.ts';
  const hash = 'hash-no-chunk-v1';

  try {
    const files: FileMeta[] = [
      {
        path: relPath,
        hash,
        mtime: Date.now(),
        size: 42,
        content: 'const a = 1;',
        language: 'typescript',
        vectorIndexHash: null,
      },
    ];

    batchUpsert(db, files);

    const before = getFilesNeedingVectorIndex(db);
    assert.ok(before.includes(relPath), '预期索引前该文件需要向量索引');

    const indexer = await getIndexer(projectId, 1024);
    const results: ProcessResult[] = [
      {
        absPath: '/tmp/no-chunk.ts',
        relPath,
        hash,
        content: 'const a = 1;',
        chunks: [],
        language: 'typescript',
        mtime: Date.now(),
        size: 42,
        status: 'added',
      },
    ];

    const stats = await indexer.indexFiles(db, results);
    assert.equal(stats.indexed, 0);
    assert.equal(stats.errors, 0);

    const after = getFilesNeedingVectorIndex(db);
    assert.equal(after.includes(relPath), false, '索引后不应再次进入 healing 集合');
  } finally {
    closeDb(db);
    closeAllIndexers();
    await closeAllVectorStores();
    await fs.rm(projectDir(projectId), { recursive: true, force: true });
  }
});
