import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const result = spawnSync('node', ['dist/index.js', '--version'], {
  encoding: 'utf8',
});

assert.equal(
  result.status,
  0,
  `Node24 冒烟失败\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
);
