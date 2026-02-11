import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { withLock } from '../../src/utils/lock.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lockPath(projectId: string): string {
  return path.join(os.homedir(), '.contextweaver', projectId, 'index.lock');
}

test('失效锁应被清理并允许后续获取', async () => {
  const projectId = `lock-stale-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const file = lockPath(projectId);

  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify({
      pid: 999_999_999,
      timestamp: Date.now(),
      operation: 'stale-test',
    }),
    'utf8',
  );

  const result = await withLock(projectId, 'repair', async () => 'ok', 800);
  assert.equal(result, 'ok');

  await fs.rm(path.dirname(file), { recursive: true, force: true });
});

test('并发锁竞争时第二个请求应在短超时内失败', async () => {
  const projectId = `lock-race-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  const holder = withLock(
    projectId,
    'holder',
    async () => {
      await sleep(260);
      return 'holder-done';
    },
    800,
  );

  await sleep(20);

  await assert.rejects(
    async () => withLock(projectId, 'waiter', async () => 'waiter-done', 120),
    /无法获取项目锁/,
  );

  assert.equal(await holder, 'holder-done');

  const afterRelease = await withLock(projectId, 'after-release', async () => 'after', 800);
  assert.equal(afterRelease, 'after');

  await fs.rm(path.join(os.homedir(), '.contextweaver', projectId), {
    recursive: true,
    force: true,
  });
});
