import assert from 'node:assert/strict';
import { createRuntime } from '../../packages/lang-ts21/src/index.js';

const runtime = createRuntime();

assert.equal(runtime.id, 'plugin-ts21');
assert.equal(runtime.canParse('kotlin'), true);
assert.equal(runtime.canParse('python'), false);

await assert.doesNotReject(async () => {
  const parser = await runtime.getParser('python');
  assert.equal(parser, null);
});
