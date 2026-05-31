import assert from 'node:assert/strict';
import { RuntimeRegistry } from '../../src/chunking/runtime/RuntimeRegistry.js';

const emptyRegistry = new RuntimeRegistry();
assert.deepEqual(emptyRegistry.listLanguages(), []);

const registry = new RuntimeRegistry();

registry.register({
  id: 'runtime-a',
  languages: ['typescript', 'javascript', 'typescript'],
  canParse: (language) => ['typescript', 'javascript'].includes(language),
  getParser: async () => null,
});

registry.register({
  id: 'runtime-b',
  languages: ['python', 'javascript'],
  canParse: (language) => language === 'python' || language === 'javascript',
  getParser: async () => null,
});

assert.deepEqual(registry.listLanguages(), ['typescript', 'javascript', 'python']);

assert.throws(
  () => {
    registry.register({
      id: 'runtime-a',
      languages: ['go'],
      canParse: (language) => language === 'go',
      getParser: async () => null,
    });
  },
  /runtime-a/,
);
