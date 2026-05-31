import fs from 'node:fs/promises';
import path from 'node:path';
import ignore from 'ignore';
import { getExcludePatterns, getIncludePatterns } from '../config.js';
import { isAllowedExtension } from './language.js';

let ignoreInstance: ignore.Ignore | null = null;
let includeMatcher: ignore.Ignore | null = null;
let lastConfigHash: string | null = null;

/**
 * 生成配置文件内容的 hash
 */
async function generateConfigHash(rootPath: string): Promise<string> {
  const crypto = await import('node:crypto');
  const hashes: string[] = [];

  async function addFileHash(filePath: string): Promise<void> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      hashes.push(crypto.createHash('sha256').update(content).digest('hex'));
    } catch {
      // 文件不存在，跳过
    }
  }

  await addFileHash(path.join(rootPath, '.gitignore'));
  await addFileHash(path.join(rootPath, '.contextweaverinclude'));

  // 加上环境变量 IGNORE_PATTERNS
  const envExcludePatterns = process.env.IGNORE_PATTERNS || '';
  hashes.push(crypto.createHash('sha256').update(envExcludePatterns).digest('hex'));

  // 加上环境变量 INCLUDE_PATTERNS
  const envIncludePatterns = process.env.INCLUDE_PATTERNS || '';
  hashes.push(crypto.createHash('sha256').update(envIncludePatterns).digest('hex'));

  // 合并所有 hashes
  const combined = hashes.join('|');
  return crypto.createHash('sha256').update(combined).digest('hex');
}

/**
 * 初始化过滤器
 */
export async function initFilter(rootPath: string): Promise<void> {
  const currentHash = await generateConfigHash(rootPath);

  if (lastConfigHash === currentHash && ignoreInstance && includeMatcher) {
    return; // 配置未变更，复用实例
  }

  const ig = ignore();
  ig.add(getExcludePatterns());

  // 加载 .gitignore
  const gitignorePath = path.join(rootPath, '.gitignore');
  try {
    await fs.access(gitignorePath);
    ig.add(await fs.readFile(gitignorePath, 'utf-8'));
  } catch {
    // 文件不存在，静默跳过
  }

  const includeIg = ignore();
  includeIg.add(getIncludePatterns());

  // 加载 .contextweaverinclude
  const includePath = path.join(rootPath, '.contextweaverinclude');
  try {
    await fs.access(includePath);
    includeIg.add(await fs.readFile(includePath, 'utf-8'));
  } catch {
    // 文件不存在，静默跳过
  }

  ignoreInstance = ig;
  includeMatcher = includeIg;
  lastConfigHash = currentHash;
}

/**
 * 判断文件路径是否应该被过滤掉
 */
export function isFiltered(relativePath: string): boolean {
  if (!ignoreInstance) {
    throw new Error('Filter not initialized. Call initFilter() first.');
  }
  return ignoreInstance.ignores(relativePath);
}

/**
 * 判断文件是否允许进入扫描
 *
 * 规则：
 * 1. 已知扩展名白名单始终允许
 * 2. 未知扩展名仅当命中显式 include 模式时允许
 */
export function isAllowedFile(filePath: string, relativePath?: string): boolean {
  if (isAllowedExtension(filePath)) {
    return true;
  }

  if (!includeMatcher) {
    throw new Error('Filter not initialized. Call initFilter() first.');
  }

  const normalizedPath = (relativePath ?? filePath).replace(/\\/g, '/');
  return includeMatcher.ignores(normalizedPath);
}
