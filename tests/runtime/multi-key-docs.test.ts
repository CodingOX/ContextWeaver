import assert from 'node:assert/strict';
import fs from 'node:fs';

const readme = fs.readFileSync('README.md', 'utf8');
const cliTemplateSource = fs.readFileSync('src/index.ts', 'utf8');
const mcpTemplateSource = fs.readFileSync('src/mcp/tools/codebaseRetrieval.ts', 'utf8');

assert.match(readme, /#\s*EMBEDDINGS_API_KEYS=key-1,key-2/);
assert.match(readme, /#\s*RERANK_API_KEYS=key-1,key-2/);
assert.match(readme, /\| `EMBEDDINGS_API_KEYS` \|/);
assert.match(readme, /\| `RERANK_API_KEYS` \|/);
assert.match(readme, /EMBEDDINGS_API_KEYS[\s\S]*兼容[\s\S]*EMBEDDINGS_API_KEY/);
assert.match(readme, /RERANK_API_KEYS[\s\S]*兼容[\s\S]*RERANK_API_KEY/);
assert.match(readme, /EMBEDDINGS_API_KEYS[\s\S]*优先[\s\S]*EMBEDDINGS_API_KEY/);
assert.match(readme, /RERANK_API_KEYS[\s\S]*优先[\s\S]*RERANK_API_KEY/);

assert.match(cliTemplateSource, /# EMBEDDINGS_API_KEYS=[^\n]*,[^\n]*/);
assert.match(cliTemplateSource, /# RERANK_API_KEYS=[^\n]*,[^\n]*/);
assert.match(mcpTemplateSource, /# EMBEDDINGS_API_KEYS=[^\n]*,[^\n]*/);
assert.match(mcpTemplateSource, /# RERANK_API_KEYS=[^\n]*,[^\n]*/);
assert.match(mcpTemplateSource, /EMBEDDINGS_API_KEY=your-api-key-here\s+# ← 单 key 写法（兼容）/);
assert.match(mcpTemplateSource, /RERANK_API_KEY=your-api-key-here\s+# ← 单 key 写法（兼容）/);
