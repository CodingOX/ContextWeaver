import assert from 'node:assert/strict';
import fs from 'node:fs';

const readme = fs.readFileSync('README.md', 'utf8');

assert.match(readme, /按需语言插件/);
assert.match(readme, /默认核心支持/);
assert.match(readme, /TypeScript/);
assert.match(readme, /Kotlin/);
assert.match(readme, /Java/);
assert.match(readme, /Rust/);
assert.match(readme, /@alistar\.max\/coderecall-lang-csharp/);
assert.doesNotMatch(readme, /@alistar\.max\/coderecall-lang-all/);
assert.doesNotMatch(readme, /@alistar\.max\/coderecall-lang-ts21/);
assert.doesNotMatch(readme, /@alistar\.max\/coderecall-lang-ts22/);
assert.match(readme, /Node\.js >= 20 且 < 24/);
assert.match(readme, /不支持 Node 24/);
