import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChunkFtsDoc } from '../../src/indexer/index.js';

test('构建分字段 chunks_fts 文档应包含 symbol/body/comments', () => {
  const breadcrumb = 'src/a.ts > class AuthService > method login';
  const displayCode = `
// 登录入口
export class AuthService {
  login_user(user_name: string) {
    return user_name;
  }
}
`.trim();

  const doc = buildChunkFtsDoc({
    chunkId: 'src/a.ts#hash#0',
    filePath: 'src/a.ts',
    chunkIndex: 0,
    breadcrumb,
    displayCode,
  });

  assert.equal(doc.breadcrumb, breadcrumb);
  assert.equal(doc.body.includes('// 登录入口'), false);
  assert.equal(doc.comments.includes('登录入口'), true);

  // symbol token 变体：原词 + snake/camel 变体
  assert.equal(doc.symbolTokens.includes('AuthService'), true);
  assert.equal(doc.symbolTokens.includes('auth_service'), true);
  assert.equal(doc.symbolTokens.includes('login_user'), true);
  assert.equal(doc.symbolTokens.includes('loginUser'), true);
});

