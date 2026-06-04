import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('search 支持语言过滤 flags 并进入真实参数冲突校验', { concurrency: false }, () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'coderecall-cli-language-flags-'));

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
        '--technical-terms',
        'AuthService, SearchService',
        '--source-code-only',
        '--include-languages',
        'typescript,python',
        '--exclude-languages',
        'markdown,json',
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
    assert.doesNotMatch(result.stderr, /Unknown option/);
    assert.match(result.stderr, /source_code_only.*include_languages.*互斥/);
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('search 配置缺失时返回非零退出码', { concurrency: false }, () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'coderecall-cli-missing-env-'));

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

test('search 在日志目录不可写时不应因 logger 崩溃', { concurrency: false }, () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'coderecall-cli-readonly-logs-'));
  const logDir = path.join(fakeHome, '.coderecall', 'logs');

  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.chmodSync(logDir, 0o555);

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
    assert.doesNotMatch(result.stderr, /ERR_STREAM_DESTROYED/);
    assert.match(result.stdout, /配置缺失/);
  } finally {
    fs.chmodSync(logDir, 0o755);
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});
