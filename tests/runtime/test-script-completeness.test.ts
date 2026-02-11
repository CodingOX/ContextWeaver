import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

interface PackageJson {
  scripts?: Record<string, string>;
}

function extractTestFiles(command: string): Set<string> {
  const matches = command.match(/tests\/[\w\-/\.]+\.test\.ts/g) ?? [];
  return new Set(matches);
}

async function listTestFiles(relativeDir: string): Promise<string[]> {
  const root = path.resolve(relativeDir);
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
    .map((entry) => path.posix.join(relativeDir, entry.name));
  return files.sort();
}

test('pnpm test 应覆盖 tests/runtime 下全部 *.test.ts', async () => {
  const pkg = JSON.parse(await fs.readFile('package.json', 'utf8')) as PackageJson;
  const testScript = pkg.scripts?.test ?? '';

  const declared = extractTestFiles(testScript);
  const runtimeTests = await listTestFiles('tests/runtime');

  const missing = runtimeTests.filter((file) => !declared.has(file));

  assert.deepEqual(
    missing,
    [],
    `pnpm test 缺少测试文件: ${missing.join(', ') || '(none)'}`,
  );
});

test('pnpm run test:benchmark 应覆盖 tests/benchmark 下全部 *.test.ts', async () => {
  const pkg = JSON.parse(await fs.readFile('package.json', 'utf8')) as PackageJson;
  const benchmarkScript = pkg.scripts?.['test:benchmark'] ?? '';

  const declared = extractTestFiles(benchmarkScript);
  const benchmarkTests = await listTestFiles('tests/benchmark');

  const missing = benchmarkTests.filter((file) => !declared.has(file));

  assert.deepEqual(
    missing,
    [],
    `pnpm run test:benchmark 缺少测试文件: ${missing.join(', ') || '(none)'}`,
  );
});

test('应提供 test:unit:all 统一入口（test + benchmark）', async () => {
  const pkg = JSON.parse(await fs.readFile('package.json', 'utf8')) as PackageJson;
  const command = pkg.scripts?.['test:unit:all'];

  assert.ok(command, '缺少 scripts.test:unit:all');
  assert.ok(command?.includes('pnpm test'), 'test:unit:all 需包含 pnpm test');
  assert.ok(command?.includes('pnpm run test:benchmark'), 'test:unit:all 需包含 pnpm run test:benchmark');
});
