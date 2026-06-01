import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const result = spawnSync('node', ['scripts/check-node-version.js'], {
  encoding: 'utf8',
});

assert.notEqual(
  result.status,
  0,
  `Node24 安装守卫未生效\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
);

assert.match(result.stderr, /Node 24/);
