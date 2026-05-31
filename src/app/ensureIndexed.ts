import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../utils/logger.js';

const DEFAULT_BASE_DIR = path.join(os.homedir(), '.contextweaver');

export type ProgressCallback = (current: number, total?: number, message?: string) => void;

export interface EnsureIndexedOptions {
  baseDir?: string;
  withLock: <T>(projectId: string, operation: string, fn: () => Promise<T>) => Promise<T>;
  scan: (
    repoPath: string,
    options: { vectorIndex: boolean; onProgress?: ProgressCallback },
  ) => Promise<{
    totalFiles: number;
    added: number;
    modified: number;
    unchanged: number;
    deleted: number;
    skipped: number;
    errors: number;
    vectorIndex?: {
      indexed: number;
      deleted: number;
      errors: number;
    };
  }>;
}

export interface EnsureIndexedResult {
  wasIndexed: boolean;
  stats: {
    totalFiles: number;
    added: number;
    modified: number;
    unchanged: number;
    deleted: number;
    skipped: number;
    errors: number;
    vectorIndex?: {
      indexed: number;
      deleted: number;
      errors: number;
    };
  };
}

function isProjectIndexed(baseDir: string, projectId: string): boolean {
  const dbPath = path.join(baseDir, projectId, 'index.db');
  return fs.existsSync(dbPath);
}

/**
 * 确保代码库已索引。
 *
 * `wasIndexed` 记录的是“进入锁之后、扫描开始之前”的状态。
 * 这样可以稳定表达首次扫描与增量扫描的分支，不受本次扫描结果影响。
 */
export async function ensureIndexed(
  repoPath: string,
  projectId: string,
  options: EnsureIndexedOptions,
  onProgress?: ProgressCallback,
): Promise<EnsureIndexedResult> {
  const baseDir = options.baseDir ?? DEFAULT_BASE_DIR;

  return options.withLock(projectId, 'index', async () => {
    const wasIndexed = isProjectIndexed(baseDir, projectId);

    if (!wasIndexed) {
      logger.info(
        { repoPath, projectId: projectId.slice(0, 10) },
        '代码库未初始化，开始首次索引...',
      );
      onProgress?.(0, 100, '代码库未索引，开始首次索引...');
    } else {
      logger.debug({ projectId: projectId.slice(0, 10) }, '执行增量索引...');
    }

    const startTime = Date.now();
    const stats = await options.scan(repoPath, { vectorIndex: true, onProgress });
    const elapsed = Date.now() - startTime;

    logger.info(
      {
        projectId: projectId.slice(0, 10),
        isFirstTime: !wasIndexed,
        totalFiles: stats.totalFiles,
        added: stats.added,
        modified: stats.modified,
        deleted: stats.deleted,
        vectorIndex: stats.vectorIndex,
        elapsedMs: elapsed,
      },
      '索引完成',
    );

    return { wasIndexed, stats };
  });
}
