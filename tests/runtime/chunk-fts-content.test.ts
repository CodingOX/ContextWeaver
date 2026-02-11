import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChunkFtsDoc } from '../../src/indexer/index.js';

test('构建 chunks_fts 文档时 content 不应重复拼接 breadcrumb', () => {
  const breadcrumb = 'src/a.ts > class A > method run';
  const displayCode = 'run() { return 1; }';

  const doc = buildChunkFtsDoc({
    chunkId: 'src/a.ts#hash#0',
    filePath: 'src/a.ts',
    chunkIndex: 0,
    breadcrumb,
    displayCode,
  });

  assert.equal(doc.breadcrumb, breadcrumb);
  assert.equal(doc.content, displayCode);
  assert.equal(doc.content.includes(breadcrumb), false);
});
