import assert from 'node:assert/strict';
import test from 'node:test';
import { buildQueryChannels } from '../../src/search/queryChannels.js';

test('查询分通道构建符合向量/词法/rerank 预期', () => {
  const channels = buildQueryChannels({
    informationRequest: '如何处理登录流程',
    technicalTerms: ['AuthService', 'login'],
  });

  assert.equal(channels.vectorQuery, '如何处理登录流程');
  assert.equal(channels.lexicalQuery, 'AuthService login 如何处理登录流程');
  assert.equal(channels.rerankQuery, '如何处理登录流程 AuthService login');
});

test('未传 technical_terms 时三个通道都应回落到 information_request', () => {
  const channels = buildQueryChannels({
    informationRequest: 'trace cache invalidation flow',
  });

  assert.equal(channels.vectorQuery, 'trace cache invalidation flow');
  assert.equal(channels.lexicalQuery, 'trace cache invalidation flow');
  assert.equal(channels.rerankQuery, 'trace cache invalidation flow');
});
