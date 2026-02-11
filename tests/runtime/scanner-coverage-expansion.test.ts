import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { crawl } from '../../src/scanner/crawler.js';
import { initFilter } from '../../src/scanner/filter.js';
import { processFiles } from '../../src/scanner/processor.js';

function buildLargeTypeScriptContent(targetBytes: number): string {
  const lines: string[] = [];
  let currentBytes = 0;
  let index = 0;

  while (currentBytes < targetBytes) {
    const line = `export function fn${index}(): number { return ${index}; }\n`;
    lines.push(line);
    currentBytes += Buffer.byteLength(line, 'utf8');
    index += 1;
  }

  return lines.join('');
}

test('大于 100KB 且小于 500KB 的 TS 文件不应被跳过，并应产出 chunks', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'contextweaver-large-ts-'));

  try {
    const filePath = path.join(tempRoot, 'large.ts');
    const content = buildLargeTypeScriptContent(150 * 1024);
    await fs.writeFile(filePath, content, 'utf8');

    const stat = await fs.stat(filePath);
    assert.ok(stat.size > 100 * 1024, `文件大小应大于 100KB，实际 ${stat.size}`);
    assert.ok(stat.size < 500 * 1024, `文件大小应小于 500KB，实际 ${stat.size}`);

    const results = await processFiles(tempRoot, [filePath], new Map());
    assert.equal(results.length, 1);

    const [result] = results;
    assert.notEqual(result.status, 'skipped');
    assert.ok(result.chunks.length > 0, '应至少生成一个 chunk');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('未知扩展名默认不允许，配置 include 后允许', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'contextweaver-include-'));

  try {
    const unknownFilePath = path.join(tempRoot, 'notes.prompt');
    await fs.writeFile(unknownFilePath, 'prompt content', 'utf8');

    await initFilter(tempRoot);
    const defaultPaths = await crawl(tempRoot);
    assert.equal(defaultPaths.includes(unknownFilePath), false);

    const includeConfigPath = path.join(tempRoot, '.contextweaverinclude');
    await fs.writeFile(includeConfigPath, '**/*.prompt\n', 'utf8');

    await initFilter(tempRoot);
    const includedPaths = await crawl(tempRoot);
    assert.equal(includedPaths.includes(unknownFilePath), true);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
