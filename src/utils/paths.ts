import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CODE_RECALL_DIRNAME = '.coderecall';
const DEFAULT_ENV_NAME = '.env';
const FALLBACK_BASE_DIR = path.join(os.tmpdir(), 'coderecall');

function ensureDirWritable(dirPath: string): boolean {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    fs.accessSync(dirPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveHomeBaseDir(): string {
  return path.join(os.homedir(), CODE_RECALL_DIRNAME);
}

export function getPreferredHomeConfigBaseDir(): string {
  return resolveHomeBaseDir();
}

let cachedDataBaseDir: string | null = null;

/**
 * 获取配置目录。
 *
 * 配置文件默认放在 HOME 下，便于用户跨仓库复用。
 * 若 HOME 目录本身不可写，则回退到临时目录，保证受限环境下仍可运行。
 */
export function getConfigBaseDir(): string {
  const homeBaseDir = resolveHomeBaseDir();
  if (ensureDirWritable(homeBaseDir)) {
    return homeBaseDir;
  }

  const fallbackConfigDir = path.join(FALLBACK_BASE_DIR, 'config');
  ensureDirWritable(fallbackConfigDir);
  return fallbackConfigDir;
}

/**
 * 获取运行时数据根目录。
 *
 * 索引库、向量库、锁文件都应共用这一根目录。
 * 优先使用 HOME 下的 .coderecall；若当前环境不允许写入，则自动回退到临时目录。
 */
export function getDataBaseDir(): string {
  if (cachedDataBaseDir) {
    return cachedDataBaseDir;
  }

  const homeBaseDir = resolveHomeBaseDir();
  if (ensureDirWritable(homeBaseDir)) {
    cachedDataBaseDir = homeBaseDir;
    return cachedDataBaseDir;
  }

  const fallbackDataDir = path.join(FALLBACK_BASE_DIR, 'data');
  ensureDirWritable(fallbackDataDir);
  cachedDataBaseDir = fallbackDataDir;
  return cachedDataBaseDir;
}

export function getLogDir(): string {
  return path.join(getDataBaseDir(), 'logs');
}

export function getProjectDataDir(projectId: string): string {
  return path.join(getDataBaseDir(), projectId);
}

export function getProjectDbPath(projectId: string): string {
  return path.join(getProjectDataDir(projectId), 'index.db');
}

export function getProjectVectorDir(projectId: string): string {
  return path.join(getProjectDataDir(projectId), 'vectors.lance');
}

export function getProjectLockPath(projectId: string): string {
  return path.join(getProjectDataDir(projectId), 'index.lock');
}

export function getDefaultEnvFilePath(): string {
  return path.join(getConfigBaseDir(), DEFAULT_ENV_NAME);
}

export function getPreferredHomeEnvFilePath(): string {
  return path.join(getPreferredHomeConfigBaseDir(), DEFAULT_ENV_NAME);
}
