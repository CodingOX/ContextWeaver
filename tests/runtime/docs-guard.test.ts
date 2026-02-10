import assert from 'node:assert/strict';
import fs from 'node:fs';

const readme = fs.readFileSync('README.md', 'utf8');

assert.match(readme, /可选语言插件/);
assert.match(readme, /@alistar\.max\/contextweaver-lang-all/);
assert.match(readme, /@alistar\.max\/contextweaver-lang-typescript/);
assert.match(readme, /@alistar\.max\/contextweaver-lang-rust/);
assert.match(readme, /@alistar\.max\/contextweaver-lang-ts21/);
assert.match(readme, /@alistar\.max\/contextweaver-lang-ts22/);
assert.match(readme, /Node\.js >= 20 且 < 25/);
