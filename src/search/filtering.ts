import type { SearchScopeOptions } from './types.js';

export interface SearchFilter {
  excludeLanguages?: string[];
  excludePathPrefixes?: string[];
}

/**
 * 将高层搜索范围选项映射为协议无关的过滤描述。
 */
export function createSearchFilter(
  input: SearchScopeOptions = {},
): SearchFilter | undefined {
  if (!input.codeOnly) {
    return undefined;
  }

  return {
    excludeLanguages: ['markdown'],
  };
}

/**
 * 统一的过滤判定函数，供召回、扩展、打包等阶段复用。
 */
export function matchesSearchFilter(
  filter: SearchFilter | undefined,
  item: { filePath: string; language?: string },
): boolean {
  if (!filter) {
    return true;
  }

  if (filter.excludeLanguages?.includes(item.language || '')) {
    return false;
  }

  if (filter.excludePathPrefixes?.some((prefix) => item.filePath.startsWith(prefix))) {
    return false;
  }

  return true;
}
