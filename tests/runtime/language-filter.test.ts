import assert from 'node:assert/strict';
import test from 'node:test';
import { initDb } from '../../src/db/index.js';
import {
  normalizeLanguageFilter,
  validateLanguageFilterConflicts,
  validateLanguageWhitelist,
} from '../../src/mcp/tools/codebaseRetrieval.js';
import {
  getCodeLanguages,
  getLanguage,
  isKnownLanguage,
  LANGUAGE_CATEGORIES,
} from '../../src/scanner/language.js';
import {
  batchUpsertChunkFts,
  batchUpsertFileFts,
  initChunksFts,
  initFilesFts,
  searchChunksFts,
  searchFilesFts,
} from '../../src/search/fts.js';
import { buildLanguageWhereClause } from '../../src/search/SearchService.js';

// ─── 语言分类 ───

test('getCodeLanguages 不含 docs/config 类语言', () => {
  const codeLangs = getCodeLanguages();
  const nonCodeLangs = [...LANGUAGE_CATEGORIES.docs, ...LANGUAGE_CATEGORIES.config];
  for (const lang of nonCodeLangs) {
    assert.ok(!codeLangs.includes(lang), `code languages should not contain ${lang}`);
  }
  assert.ok(codeLangs.includes('typescript'));
  assert.ok(codeLangs.includes('python'));
  assert.equal(codeLangs.length, 26);
});

test('isKnownLanguage 识别白名单语言', () => {
  assert.equal(isKnownLanguage('typescript'), true);
  assert.equal(isKnownLanguage('python'), true);
  assert.equal(isKnownLanguage('markdown'), true);
  assert.equal(isKnownLanguage('unknown_x'), false);
  assert.equal(isKnownLanguage(''), false);
});

test('getLanguage 通过扩展名推断语言', () => {
  assert.equal(getLanguage('src/app.ts'), 'typescript');
  assert.equal(getLanguage('README.md'), 'markdown');
  assert.equal(getLanguage('config.json'), 'json');
  assert.equal(getLanguage('unknown.xyz'), 'unknown');
});

// ─── 参数冲突校验 ───

test('source_code_only + include_languages 应报错', () => {
  assert.throws(
    () =>
      validateLanguageFilterConflicts({
        source_code_only: true,
        include_languages: ['typescript'],
      }),
    /互斥/,
  );
});

test('include/exclude 交集应报错', () => {
  assert.throws(
    () =>
      validateLanguageFilterConflicts({
        include_languages: ['typescript', 'python'],
        exclude_languages: ['python'],
      }),
    /交集.*python/,
  );
});

test('source_code_only + exclude_languages 允许通过', () => {
  assert.doesNotThrow(() =>
    validateLanguageFilterConflicts({
      source_code_only: true,
      exclude_languages: ['shell'],
    }),
  );
});

test('无参数时冲突校验不报错', () => {
  assert.doesNotThrow(() => validateLanguageFilterConflicts({}));
});

// ─── 白名单校验 ───

test('未知语言值应报错', () => {
  assert.throws(
    () => validateLanguageWhitelist(['typescript', 'fake_lang']),
    /未知语言值.*fake_lang/,
  );
});

test('合法语言值不报错', () => {
  assert.doesNotThrow(() => validateLanguageWhitelist(['typescript', 'python', 'unknown']));
});

test('空数组和 undefined 不报错', () => {
  assert.doesNotThrow(() => validateLanguageWhitelist([]));
  assert.doesNotThrow(() => validateLanguageWhitelist(undefined));
});

// ─── 归一化 ───

test('无参数归一化返回 undefined', () => {
  assert.equal(normalizeLanguageFilter({}), undefined);
});

test('source_code_only 归一化为代码语言列表', () => {
  const result = normalizeLanguageFilter({ source_code_only: true });
  assert.ok(result);
  assert.ok(result.includes('typescript'));
  assert.ok(!result.includes('markdown'));
  assert.ok(!result.includes('json'));
});

test('source_code_only + exclude_languages 叠加过滤', () => {
  const result = normalizeLanguageFilter({
    source_code_only: true,
    exclude_languages: ['shell', 'powershell'],
  });
  assert.ok(result);
  assert.ok(!result.includes('shell'));
  assert.ok(!result.includes('powershell'));
  assert.ok(result.includes('typescript'));
});

test('include_languages 直接透传', () => {
  const result = normalizeLanguageFilter({ include_languages: ['typescript', 'python'] });
  assert.deepEqual(result, ['typescript', 'python']);
});

test('仅 exclude_languages 归一化返回 undefined', () => {
  assert.equal(normalizeLanguageFilter({ exclude_languages: ['markdown'] }), undefined);
});

// ─── WHERE 子句构造 ───

test('buildLanguageWhereClause undefined → undefined', () => {
  assert.equal(buildLanguageWhereClause(undefined), undefined);
  assert.equal(buildLanguageWhereClause([]), undefined);
});

test('buildLanguageWhereClause 单语言', () => {
  assert.equal(buildLanguageWhereClause(['typescript']), "language = 'typescript'");
});

test('buildLanguageWhereClause 多语言', () => {
  const result = buildLanguageWhereClause(['typescript', 'python']);
  assert.equal(result, "language IN ('typescript', 'python')");
});

// ─── FTS 语言过滤（chunks_fts） ───

test('searchChunksFts 无 languages 参数时行为不变（零回归）', () => {
  const projectId = `lang-filter-chunk-regression-${Date.now()}`;
  const db = initDb(projectId);
  try {
    initChunksFts(db);
    batchUpsertChunkFts(db, [
      {
        chunkId: 'src/a.ts#h#0',
        filePath: 'src/a.ts',
        chunkIndex: 0,
        symbolTokens: 'AuthService',
        breadcrumb: 'src/a.ts > class AuthService',
        body: 'export class AuthService {}',
        comments: '',
      },
    ]);

    const withoutFilter = searchChunksFts(db, 'AuthService', 5);
    const withUndefined = searchChunksFts(db, 'AuthService', 5, undefined);
    const withEmpty = searchChunksFts(db, 'AuthService', 5, []);

    assert.equal(withoutFilter.length, withUndefined.length);
    assert.equal(withoutFilter.length, withEmpty.length);
    assert.ok(withoutFilter.length > 0);
  } finally {
    db.close();
  }
});

test('searchChunksFts 语言过滤排除非目标语言', () => {
  const projectId = `lang-filter-chunk-${Date.now()}`;
  const db = initDb(projectId);
  try {
    initChunksFts(db);

    // 插入 files 表记录（供子查询关联）
    db.prepare(
      'INSERT OR REPLACE INTO files (path, hash, mtime, size, content, language) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('src/a.ts', 'hash1', Date.now(), 100, 'export class AuthService {}', 'typescript');
    db.prepare(
      'INSERT OR REPLACE INTO files (path, hash, mtime, size, content, language) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('README.md', 'hash2', Date.now(), 50, 'AuthService documentation', 'markdown');

    batchUpsertChunkFts(db, [
      {
        chunkId: 'src/a.ts#h#0',
        filePath: 'src/a.ts',
        chunkIndex: 0,
        symbolTokens: 'AuthService',
        breadcrumb: 'src/a.ts > class AuthService',
        body: 'export class AuthService {}',
        comments: '',
      },
      {
        chunkId: 'README.md#h#0',
        filePath: 'README.md',
        chunkIndex: 0,
        symbolTokens: '',
        breadcrumb: 'README.md',
        body: 'AuthService documentation guide',
        comments: '',
      },
    ]);

    // 不过滤：两个都应该命中
    const all = searchChunksFts(db, 'AuthService', 10);
    assert.equal(all.length, 2);

    // 只搜 typescript：排除 markdown
    const tsOnly = searchChunksFts(db, 'AuthService', 10, ['typescript']);
    assert.equal(tsOnly.length, 1);
    assert.equal(tsOnly[0].filePath, 'src/a.ts');

    // 只搜 markdown：排除 typescript
    const mdOnly = searchChunksFts(db, 'AuthService', 10, ['markdown']);
    assert.equal(mdOnly.length, 1);
    assert.equal(mdOnly[0].filePath, 'README.md');
  } finally {
    db.close();
  }
});

// ─── FTS 语言过滤（files_fts） ───

test('searchFilesFts 语言过滤排除非目标语言', () => {
  const projectId = `lang-filter-file-${Date.now()}`;
  const db = initDb(projectId);
  try {
    initFilesFts(db);

    // 插入 files 表记录
    db.prepare(
      'INSERT OR REPLACE INTO files (path, hash, mtime, size, content, language) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      'src/service.ts',
      'hash1',
      Date.now(),
      200,
      'export class UserService { getUser() {} }',
      'typescript',
    );
    db.prepare(
      'INSERT OR REPLACE INTO files (path, hash, mtime, size, content, language) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      'docs/guide.md',
      'hash2',
      Date.now(),
      100,
      'UserService usage guide documentation',
      'markdown',
    );

    batchUpsertFileFts(db, [
      { path: 'src/service.ts', content: 'export class UserService { getUser() {} }' },
      { path: 'docs/guide.md', content: 'UserService usage guide documentation' },
    ]);

    // 不过滤
    const all = searchFilesFts(db, 'UserService', 10);
    assert.equal(all.length, 2);

    // 只搜 typescript
    const tsOnly = searchFilesFts(db, 'UserService', 10, ['typescript']);
    assert.equal(tsOnly.length, 1);
    assert.equal(tsOnly[0].path, 'src/service.ts');

    // 只搜 markdown
    const mdOnly = searchFilesFts(db, 'UserService', 10, ['markdown']);
    assert.equal(mdOnly.length, 1);
    assert.equal(mdOnly[0].path, 'docs/guide.md');
  } finally {
    db.close();
  }
});

// ─── idx_files_language 索引验证 ───

test('idx_files_language 索引存在', () => {
  const projectId = `lang-idx-${Date.now()}`;
  const db = initDb(projectId);
  try {
    const result = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_files_language'")
      .get() as { name: string } | undefined;
    assert.ok(result, 'idx_files_language index should exist');
    assert.equal(result.name, 'idx_files_language');
  } finally {
    db.close();
  }
});
