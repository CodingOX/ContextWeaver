import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEFAULT_ENV_TEMPLATE } from '../../src/config.js';

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

// 统一模板: KEYS 作为默认项，单 key 为注释
assert.match(DEFAULT_ENV_TEMPLATE, /^EMBEDDINGS_API_KEYS=your-api-key-here$/m);
assert.match(DEFAULT_ENV_TEMPLATE, /^#\s*EMBEDDINGS_API_KEY=your-api-key-here$/m);
assert.match(DEFAULT_ENV_TEMPLATE, /^RERANK_API_KEYS=your-api-key-here$/m);
assert.match(DEFAULT_ENV_TEMPLATE, /^#\s*RERANK_API_KEY=your-api-key-here$/m);

// CLI/MCP 不应再维护第二份可漂移的 env 模板。
assert.match(cliTemplateSource, /DEFAULT_ENV_TEMPLATE/);
assert.match(mcpTemplateSource, /DEFAULT_ENV_TEMPLATE/);
