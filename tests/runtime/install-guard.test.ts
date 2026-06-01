import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('主包应声明 preinstall 守卫并随发布包携带脚本', async () => {
  const pkg = JSON.parse(await fs.readFile('package.json', 'utf8')) as {
    engines?: { node?: string };
    files?: string[];
    scripts?: Record<string, string>;
  };

  assert.equal(pkg.engines?.node, '>=20 <24');
  assert.equal(pkg.scripts?.preinstall, 'node scripts/check-node-version.js');
  assert.ok(pkg.files?.includes('scripts/check-node-version.js'));
});

test('Node 24 应在安装守卫阶段被拦截并提示切换 Node 22', () => {
  const result = spawnSync('node', ['scripts/check-node-version.js'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CONTEXTWEAVER_NODE_VERSION_OVERRIDE: 'v24.16.0',
    },
  });

  assert.notEqual(result.status, 0, 'Node 24 预期应被拦截');
  assert.match(result.stderr, /Node 24/);
  assert.match(result.stderr, /Node 22 LTS/);
});

test('Node 22 应通过安装守卫', () => {
  const result = spawnSync('node', ['scripts/check-node-version.js'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CONTEXTWEAVER_NODE_VERSION_OVERRIDE: 'v22.17.0',
    },
  });

  assert.equal(result.status, 0, `Node 22 不应被拦截: ${result.stderr}`);
});
