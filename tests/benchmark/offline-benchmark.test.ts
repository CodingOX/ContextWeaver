import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  evaluateBenchmarkCases,
  ndcgAtK,
  recallAtK,
  reciprocalRank,
} from '../../src/search/eval/metrics.js';
import { loadBenchmarkDataset } from '../../src/search/eval/dataset.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, 'fixtures/sample-offline-benchmark.jsonl');

function assertClose(actual: number, expected: number, epsilon = 1e-6) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `期望 ${expected.toFixed(6)}，实际 ${actual.toFixed(6)}`,
  );
}

test('Recall@K / MRR / nDCG 指标计算正确', () => {
  const ranked = ['doc-a', 'doc-b', 'doc-c', 'doc-d'];
  const relevant = new Set(['doc-b', 'doc-d']);
  const relevance = { 'doc-b': 2, 'doc-d': 1 };

  assertClose(recallAtK(ranked, relevant, 1), 0);
  assertClose(recallAtK(ranked, relevant, 2), 0.5);
  assertClose(recallAtK(ranked, relevant, 4), 1);
  assertClose(reciprocalRank(ranked, relevant), 0.5);

  const expectedNdcgAt3 = (2 / Math.log2(3)) / (2 + 1 / Math.log2(3));
  assertClose(ndcgAtK(ranked, relevance, 3), expectedNdcgAt3);
});

test('可从样例数据集读取并汇总离线评测指标', async () => {
  const cases = await loadBenchmarkDataset(fixturePath);
  assert.equal(cases.length, 2);

  const summary = evaluateBenchmarkCases(cases, [1, 3, 5]);

  assert.equal(summary.queryCount, 2);
  assertClose(summary.mrr, 0.5);
  assertClose(summary.recallAtK['1'], 0);
  assertClose(summary.recallAtK['3'], 0.75);
  assertClose(summary.recallAtK['5'], 1);

  const q1NdcgAt3 = (2 / Math.log2(3)) / (2 + 1 / Math.log2(3));
  const q2NdcgAt3 = 1 / Math.log2(3);
  const expectedAvgNdcgAt3 = (q1NdcgAt3 + q2NdcgAt3) / 2;
  assertClose(summary.ndcgAtK['3'], expectedAvgNdcgAt3);
});
