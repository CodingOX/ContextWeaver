import assert from 'node:assert/strict';
import fs from 'node:fs';

const readme = fs.readFileSync('README.md', 'utf8');
const cliTemplateSource = fs.readFileSync('src/index.ts', 'utf8');
const mcpTemplateSource = fs.readFileSync('src/mcp/tools/codebaseRetrieval.ts', 'utf8');

// README: KEYS 变量作为推荐默认项（非注释）
assert.match(readme, /^EMBEDDINGS_API_KEYS=your-api-key-here$/m);
assert.match(readme, /^RERANK_API_KEYS=your-api-key-here$/m);
// README: 单 key 变量作为注释兼容写法
assert.match(readme, /^#\s*EMBEDDINGS_API_KEY=your-api-key-here$/m);
assert.match(readme, /^#\s*RERANK_API_KEY=your-api-key-here$/m);
// README: 环境变量表格包含 KEYS 变量
assert.match(readme, /\| `EMBEDDINGS_API_KEYS` \|/);
assert.match(readme, /\| `RERANK_API_KEYS` \|/);
// README: 提及"兼容"和"优先"
assert.match(readme, /EMBEDDINGS_API_KEYS[\s\S]*兼容[\s\S]*EMBEDDINGS_API_KEY/);
assert.match(readme, /RERANK_API_KEYS[\s\S]*兼容[\s\S]*RERANK_API_KEY/);
assert.match(readme, /KEYS[\s\S]*优先/);

// CLI 模板: KEYS 作为默认项，单 key 为注释
assert.match(cliTemplateSource, /^EMBEDDINGS_API_KEYS=your-api-key-here$/m);
assert.match(cliTemplateSource, /^#\s*EMBEDDINGS_API_KEY=your-api-key-here$/m);
assert.match(cliTemplateSource, /^RERANK_API_KEYS=your-api-key-here$/m);
assert.match(cliTemplateSource, /^#\s*RERANK_API_KEY=your-api-key-here$/m);

// MCP 模板: KEYS 作为默认项，单 key 为注释
assert.match(mcpTemplateSource, /^EMBEDDINGS_API_KEYS=your-api-key-here$/m);
assert.match(mcpTemplateSource, /^#\s*EMBEDDINGS_API_KEY=your-api-key-here$/m);
assert.match(mcpTemplateSource, /^RERANK_API_KEYS=your-api-key-here$/m);
assert.match(mcpTemplateSource, /^#\s*RERANK_API_KEY=your-api-key-here$/m);
