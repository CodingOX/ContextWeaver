import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadAutoTuneDataset } from '../../src/search/eval/autoTuneDataset.js';
import { runAutoTune } from '../../src/search/eval/autoTune.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, 'fixtures/sample-auto-tune-dataset.jsonl');

test('自动调参数据集应正确加载 replay 字段', async () => {
  const cases = await loadAutoTuneDataset(fixturePath);
  assert.equal(cases.length, 2);
  assert.deepEqual(cases[0].vectorRetrieved.slice(0, 2), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(cases[0].lexicalRetrieved.slice(0, 2), ['src/b.ts', 'src/c.ts']);
});

test('自动调参应能选出更优的融合参数', async () => {
  const cases = await loadAutoTuneDataset(fixturePath);

  const result = runAutoTune(cases, {
    kValues: [1, 3],
    target: 'mrr',
    grid: {
      wVec: [0.2, 0.8],
      rrfK0: [20],
      fusedTopM: [3],
    },
    topN: 2,
  });

  assert.equal(result.best.config.wVec, 0.8);
  assert.equal(result.best.config.wLex, 0.2);
  assert.equal(result.leaderboard.length, 2);
  assert.ok(result.best.summary.mrr > result.leaderboard[1].summary.mrr);
});
