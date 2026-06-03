import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { batchUpsert, clear, closeDb, initDb, type FileMeta } from '../../src/db/index.js';

function projectDir(projectId: string): string {
  return path.join(os.homedir(), '.coderecall', projectId);
}

test('clear 后的全量 batchUpsert 应重建 files_fts 且记录数正确', async () => {
  const projectId = `files-fts-rebuild-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const db = initDb(projectId);

  const files: FileMeta[] = [
    {
      path: 'src/a.ts',
      hash: 'h1',
      mtime: Date.now(),
      size: 10,
      content: 'export const alpha = 1;',
      language: 'typescript',
      vectorIndexHash: null,
    },
    {
      path: 'src/b.ts',
      hash: 'h2',
      mtime: Date.now(),
      size: 12,
      content: 'export const beta = 2;',
      language: 'typescript',
      vectorIndexHash: null,
    },
    {
      path: 'README.md',
      hash: 'h3',
      mtime: Date.now(),
      size: 20,
      content: '# hello\nworld',
      language: 'markdown',
      vectorIndexHash: null,
    },
  ];

  try {
    batchUpsert(db, files);
    clear(db);
    batchUpsert(db, files);

    const filesCount = db.prepare('SELECT COUNT(*) as c FROM files').get() as { c: number };
    const filesFtsCount = db.prepare('SELECT COUNT(*) as c FROM files_fts').get() as { c: number };
    const rows = db.prepare('SELECT path, content FROM files_fts ORDER BY path').all() as Array<{
      path: string;
      content: string;
    }>;

    assert.equal(filesCount.c, 3);
    assert.equal(filesFtsCount.c, 3);
    assert.deepEqual(
      rows.map((row) => row.path),
      ['README.md', 'src/a.ts', 'src/b.ts'],
    );
    assert.equal(rows[1].content.includes('alpha'), true);
    assert.equal(rows[2].content.includes('beta'), true);
  } finally {
    closeDb(db);
    await fs.rm(projectDir(projectId), { recursive: true, force: true });
  }
});
