import assert from 'node:assert/strict';
import test from 'node:test';
import { initDb } from '../../src/db/index.js';
import { batchUpsertChunkFts, initChunksFts, searchChunksFts } from '../../src/search/fts.js';

test('chunks_fts 分字段 BM25 应优先命中 symbol_tokens', () => {
  const projectId = `fts-search-${Date.now()}`;
  const db = initDb(projectId);

  try {
    initChunksFts(db);

    batchUpsertChunkFts(db, [
      {
        chunkId: 'src/a.ts#h#0',
        filePath: 'src/a.ts',
        chunkIndex: 0,
        symbolTokens: 'AuthService auth_service',
        breadcrumb: 'src/a.ts > class AuthService',
        body: 'export class AuthService {}',
        comments: '',
      },
      {
        chunkId: 'src/b.ts#h#0',
        filePath: 'src/b.ts',
        chunkIndex: 0,
        symbolTokens: '',
        breadcrumb: 'src/b.ts > note',
        body: '',
        comments: 'AuthService AuthService AuthService',
      },
    ]);

    const results = searchChunksFts(db, 'AuthService', 5);
    assert.ok(results.length > 0);
    assert.equal(results[0].filePath, 'src/a.ts');
  } finally {
    db.close();
  }
});
