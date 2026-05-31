import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChunkIndexConsistencyReport } from '../../src/search/chunkIndexConsistency.js';

test('一致性报告应正确识别缺失项', () => {
  const vectorIds = ['a#h#0', 'a#h#1', 'b#h#0'];
  const ftsIds = ['a#h#0', 'c#h#0'];

  const report = buildChunkIndexConsistencyReport(vectorIds, ftsIds);

  assert.equal(report.vectorCount, 3);
  assert.equal(report.ftsCount, 2);
  assert.deepEqual(report.missingInFts, ['a#h#1', 'b#h#0']);
  assert.deepEqual(report.missingInVector, ['c#h#0']);
});

