import assert from 'node:assert/strict';
import { getParser, isLanguageSupported } from '../../src/chunking/ParserPool.js';
import { BuiltinRuntimeTs25 } from '../../src/chunking/runtime/BuiltinRuntimeTs25.js';

const runtime = new BuiltinRuntimeTs25();
assert.equal(runtime.canParse('go'), true);

assert.equal(isLanguageSupported('go'), true);
const parser = await getParser('go');
assert.ok(parser);

assert.equal(isLanguageSupported('toString'), false);
const unknownParser = await getParser('toString');
assert.equal(unknownParser, null);

let dartParser: Awaited<ReturnType<typeof getParser>> = null;
await assert.doesNotReject(async () => {
  dartParser = await getParser('dart');
});

assert.ok(dartParser === null || typeof dartParser === 'object');
