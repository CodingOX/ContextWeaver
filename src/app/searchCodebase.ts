import os from 'node:os';
import path from 'node:path';
import { generateProjectId } from '../db/index.js';
import { ensureDefaultEnvFile } from './ensureDefaultEnvFile.js';
import { ensureIndexed, type ProgressCallback } from './ensureIndexed.js';
import { createSearchFilter } from '../search/filtering.js';
import type { ContextPack, SearchConfig, SearchScopeOptions } from '../search/types.js';
import { logger } from '../utils/logger.js';

export class MissingEnvError extends Error {
  readonly missingVars: string[];

  constructor(missingVars: string[]) {
    super(`Missing required environment variables: ${missingVars.join(', ')}`);
    this.name = 'MissingEnvError';
    this.missingVars = [...new Set(missingVars)];
  }
}

export interface SearchCodebaseOptions extends SearchScopeOptions {
  repoPath: string;
  query: string;
  configOverride?: Partial<SearchConfig>;
  onProgress?: ProgressCallback;
  baseDir?: string;
}

export interface SearchCodebaseResult {
  projectId: string;
  query: string;
  contextPack: ContextPack;
}

/**
 * 公共搜索编排服务。
 *
 * 这里负责稳定的流程控制：环境检查、默认配置准备、索引准备、搜索执行。
 * 上层入口只做参数适配和结果格式化，不再重复实现这些步骤。
 */
export async function searchCodebase(
  options: SearchCodebaseOptions,
): Promise<SearchCodebaseResult> {
  const { repoPath, query, configOverride, onProgress, codeOnly } = options;
  const baseDir = options.baseDir ?? path.join(os.homedir(), '.contextweaver');

  logger.info(
    {
      repoPath,
      query,
    },
    '开始执行代码库搜索编排',
  );

  const { checkEmbeddingEnv, checkRerankerEnv } = await import('../config.js');
  const embeddingCheck = checkEmbeddingEnv();
  const rerankerCheck = checkRerankerEnv();
  const missingVars = [...embeddingCheck.missingVars, ...rerankerCheck.missingVars];

  if (missingVars.length > 0) {
    await ensureDefaultEnvFile(baseDir);
    throw new MissingEnvError(missingVars);
  }

  const projectId = generateProjectId(repoPath);

  await ensureIndexed(repoPath, projectId, {
    baseDir,
    withLock: async (lockedProjectId, operation, fn) => {
      const { withLock } = await import('../utils/lock.js');
      return withLock(lockedProjectId, operation, fn);
    },
    scan: async (scanRepoPath, options) => {
      const { scan } = await import('../scanner/index.js');
      return scan(scanRepoPath, options);
    },
  }, onProgress);

  const { SearchService } = await import('../search/SearchService.js');
  const service = new SearchService(
    projectId,
    repoPath,
    configOverride,
    createSearchFilter({ codeOnly }),
  );
  await service.init();

  const contextPack = await service.buildContextPack(query);

  logger.info(
    {
      projectId: projectId.slice(0, 10),
      query,
      seedCount: contextPack.seeds.length,
      expandedCount: contextPack.expanded.length,
      fileCount: contextPack.files.length,
    },
    '代码库搜索编排完成',
  );

  return {
    projectId,
    query,
    contextPack,
  };
}
