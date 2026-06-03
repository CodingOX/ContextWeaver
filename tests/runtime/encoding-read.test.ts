import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readFileWithEncoding } from '../../src/utils/encoding.js';

test('readFileWithEncoding 应快速读取 UTF-8 文件', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'coderecall-encoding-'));
  const file = path.join(dir, 'utf8.ts');

  try {
    await fs.writeFile(file, 'export const message = "中文 UTF-8";\n', 'utf8');

    const result = await readFileWithEncoding(file);

    assert.equal(result.content.includes('中文 UTF-8'), true);
    assert.equal(result.originalEncoding, 'UTF-8');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('readFileWithEncoding 对带 BOM 的非 UTF-8 文件仍应回退到 iconv 解码', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'coderecall-encoding-'));
  const file = path.join(dir, 'utf16le.txt');

  try {
    const body = Buffer.from('中文内容', 'utf16le');
    await fs.writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), body]));

    const result = await readFileWithEncoding(file);

    assert.equal(result.content.replace(/^\ufeff/, ''), '中文内容');
    assert.equal(result.originalEncoding, 'UTF-16 LE');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
