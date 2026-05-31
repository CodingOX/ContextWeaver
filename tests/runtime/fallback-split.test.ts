import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isLanguageSupported } from '../../src/chunking/ParserPool.js';
import { processFiles } from '../../src/scanner/processor.js';

assert.equal(isLanguageSupported('kotlin'), false);

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'contextweaver-fallback-kotlin-'));
const filePath = path.join(tempRoot, 'Sample.kt');

try {
  await fs.writeFile(
    filePath,
    [
      'class Sample {',
      '  fun greet(): String {',
      '    return "hello"',
      '  }',
      '}',
    ].join('\n'),
    'utf8',
  );

  const results = await processFiles(tempRoot, [filePath], new Map());
  assert.equal(results.length, 1);

  const [result] = results;
  assert.equal(result.language, 'kotlin');
  assert.ok(result.chunks.length > 0);
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
