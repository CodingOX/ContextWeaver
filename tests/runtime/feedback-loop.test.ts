import assert from 'node:assert/strict';
import test from 'node:test';
import { initDb } from '../../src/db/index.js';
import {
  ensureFeedbackTables,
  getFeedbackSummary,
  recordRetrievalEvent,
} from '../../src/search/feedbackLoop.js';

test('隐式反馈：path pin 与 no-hit rewrite 信号应被采集并汇总', () => {
  const projectId = `feedback-loop-${Date.now()}`;
  const db = initDb(projectId);

  try {
    ensureFeedbackTables(db);

    recordRetrievalEvent(db, {
      query: 'where is auth service',
      technicalTerms: ['AuthService'],
      seeds: [
        {
          chunkId: 'src/auth/AuthService.ts#h#0',
          filePath: 'src/auth/AuthService.ts',
          chunkIndex: 0,
          score: 0.91,
          source: 'vector',
        },
      ],
    });

    const second = recordRetrievalEvent(db, {
      query: 'open AuthService login function',
      technicalTerms: ['AuthService', 'login'],
      seeds: [
        {
          chunkId: 'src/auth/AuthService.ts#h#1',
          filePath: 'src/auth/AuthService.ts',
          chunkIndex: 1,
          score: 0.88,
          source: 'lexical',
        },
      ],
    });

    assert.ok(second.inferredSignals.some((signal) => signal.type === 'path_pin'));

    recordRetrievalEvent(db, {
      query: 'payment retry handler',
      technicalTerms: ['paymentRetry'],
      seeds: [],
    });

    const fourth = recordRetrievalEvent(db, {
      query: 'payment retry handler implementation',
      technicalTerms: ['paymentRetry', 'handler'],
      seeds: [
        {
          chunkId: 'src/pay/retry.ts#h#0',
          filePath: 'src/pay/retry.ts',
          chunkIndex: 0,
          score: 0.77,
          source: 'vector',
        },
      ],
    });

    assert.ok(fourth.inferredSignals.some((signal) => signal.type === 'no_hit_rewrite'));

    const summary = getFeedbackSummary(db, { days: 7, top: 5 });
    assert.equal(summary.totalEvents, 4);
    assert.ok(summary.zeroHitRate > 0);
    assert.ok(summary.implicitSuccessRate > 0);
    assert.ok(summary.topFiles.some((item) => item.filePath.includes('AuthService.ts')));
  } finally {
    db.close();
  }
});
