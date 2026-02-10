import assert from 'node:assert/strict';
import { createRuntime } from '../../packages/lang-ts22/src/index.js';

const runtime = createRuntime();

assert.equal(runtime.id, 'plugin-ts22');
assert.equal(runtime.canParse('php'), true);
assert.equal(runtime.canParse('go'), false);

await assert.doesNotReject(async () => {
  const parser = await runtime.getParser('go');
  assert.equal(parser, null);
});
