import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('search 配置缺失时返回非零退出码', { concurrency: false }, () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'contextweaver-cli-missing-env-'));

  try {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/index.ts',
        'search',
        '--repo-path',
        process.cwd(),
        '--information-request',
        '定位测试入口',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          HOME: fakeHome,
          PATH: process.env.PATH ?? '',
          NODE_ENV: 'production',
        },
      },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /配置缺失/);
    assert.match(result.stdout, /EMBEDDINGS_API_KEY 或 EMBEDDINGS_API_KEYS/);
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});
