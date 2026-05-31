import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../utils/logger.js';

const DEFAULT_BASE_DIR = path.join(os.homedir(), '.contextweaver');

const DEFAULT_ENV_CONTENT = `# ContextWeaver 示例环境变量配置文件

# Embedding API 配置（必需）
EMBEDDINGS_API_KEY=your-api-key-here
EMBEDDINGS_BASE_URL=https://api.siliconflow.cn/v1/embeddings
EMBEDDINGS_MODEL=BAAI/bge-m3
EMBEDDINGS_MAX_CONCURRENCY=10
EMBEDDINGS_DIMENSIONS=1024

# Reranker 配置（必需）
RERANK_API_KEY=your-api-key-here
RERANK_BASE_URL=https://api.siliconflow.cn/v1/rerank
RERANK_MODEL=BAAI/bge-reranker-v2-m3
RERANK_TOP_N=20

# 索引忽略模式（可选，逗号分隔，默认已包含常见忽略项）
# IGNORE_PATTERNS=.venv,node_modules
`;

export interface EnsureDefaultEnvFileResult {
  created: boolean;
  envFile: string;
}

/**
 * 确保默认 .env 文件存在。
 *
 * 这一步只负责“准备配置入口”，不做任何环境变量解析。
 */
export async function ensureDefaultEnvFile(
  baseDir: string = DEFAULT_BASE_DIR,
): Promise<EnsureDefaultEnvFileResult> {
  const envFile = path.join(baseDir, '.env');

  if (fs.existsSync(envFile)) {
    return { created: false, envFile };
  }

  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
    logger.info({ configDir: baseDir }, '创建配置目录');
  }

  fs.writeFileSync(envFile, DEFAULT_ENV_CONTENT);
  logger.info({ envFile }, '已创建默认 .env 配置文件');

  return { created: true, envFile };
}
