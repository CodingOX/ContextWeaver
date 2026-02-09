/**
 * Ruby 解析策略 (require/autoload 解析 + 路径解析)
 */

import { commonPrefixLength, type ImportResolver } from './types.js';

export class RubyResolver implements ImportResolver {
  private exts = ['.rb'];

  supports(filePath: string): boolean {
    return filePath.endsWith('.rb');
  }

  extract(content: string): string[] {
    const imports: string[] = [];

    // 匹配 require 'foo/bar' 或 require "foo/bar"
    const requirePattern = /^\s*require\s+['"]([^'"]+)['"]/gm;
    for (const match of content.matchAll(requirePattern)) {
      imports.push(`require:${match[1]}`);
    }

    // 匹配 require_relative '../x' 或 require_relative "../x"
    const requireRelativePattern = /^\s*require_relative\s+['"]([^'"]+)['"]/gm;
    for (const match of content.matchAll(requireRelativePattern)) {
      imports.push(`require_relative:${match[1]}`);
    }

    // 匹配 autoload :Const, 'path' 或 autoload :Const, "path"
    const autoloadPattern = /^\s*autoload\s+:\w+\s*,\s*['"]([^'"]+)['"]/gm;
    for (const match of content.matchAll(autoloadPattern)) {
      imports.push(`autoload:${match[1]}`);
    }

    return imports;
  }

  resolve(importStr: string, currentFile: string, allFiles: Set<string>): string | null {
    if (importStr.startsWith('require_relative:')) {
      const relativePath = importStr.slice('require_relative:'.length);
      return this.resolveRelative(relativePath, currentFile, allFiles);
    }

    if (importStr.startsWith('require:')) {
      const requirePath = importStr.slice('require:'.length);
      return this.resolveLogicalPath(requirePath, currentFile, allFiles);
    }

    if (importStr.startsWith('autoload:')) {
      const autoloadPath = importStr.slice('autoload:'.length);
      return this.resolveLogicalPath(autoloadPath, currentFile, allFiles);
    }

    return null;
  }

  private resolveRelative(
    relativePath: string,
    currentFile: string,
    allFiles: Set<string>,
  ): string | null {
    if (!relativePath) return null;

    const currentDir = currentFile.split('/').slice(0, -1).join('/');
    const baseParts = currentDir ? currentDir.split('/') : [];
    const mergedParts = [...baseParts, ...relativePath.split('/')];
    const resolvedParts: string[] = [];

    for (const part of mergedParts) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (resolvedParts.length === 0) {
          return null;
        }
        resolvedParts.pop();
      } else {
        resolvedParts.push(part);
      }
    }

    return this.pickFirstExisting(resolvedParts.join('/'), allFiles);
  }

  private resolveLogicalPath(
    logicalPath: string,
    currentFile: string,
    allFiles: Set<string>,
  ): string | null {
    if (!logicalPath) return null;

    // Ruby 的 require/autoload 常以逻辑路径表示：foo/bar -> foo/bar.rb
    const normalized = logicalPath.replace(/^\/+/, '').replace(/\.rb$/, '');
    if (!normalized) return null;

    const candidates = this.collectSuffixCandidates(normalized, allFiles);
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    // 歧义消解：优先选择与当前文件路径前缀重叠最多的
    let bestCandidate = candidates[0];
    let bestPrefixLen = commonPrefixLength(currentFile, bestCandidate);

    for (let i = 1; i < candidates.length; i++) {
      const prefixLen = commonPrefixLength(currentFile, candidates[i]);
      if (prefixLen > bestPrefixLen) {
        bestPrefixLen = prefixLen;
        bestCandidate = candidates[i];
      }
    }

    return bestCandidate;
  }

  private pickFirstExisting(basePath: string, allFiles: Set<string>): string | null {
    // 若已带扩展名，直接检查
    if (basePath.endsWith('.rb')) {
      return allFiles.has(basePath) ? basePath : null;
    }

    // 尝试 foo/bar.rb
    for (const ext of this.exts) {
      const withExt = `${basePath}${ext}`;
      if (allFiles.has(withExt)) {
        return withExt;
      }
    }

    // 尝试 foo/bar/index.rb
    for (const ext of this.exts) {
      const indexPath = `${basePath}/index${ext}`;
      if (allFiles.has(indexPath)) {
        return indexPath;
      }
    }

    return null;
  }

  private collectSuffixCandidates(modulePath: string, allFiles: Set<string>): string[] {
    const candidates: string[] = [];
    const suffixes = [`/${modulePath}.rb`, `/${modulePath}/index.rb`];

    for (const filePath of allFiles) {
      for (const suffix of suffixes) {
        if (filePath.endsWith(suffix)) {
          const boundaryIndex = filePath.length - suffix.length;
          if (boundaryIndex <= 0 || filePath[boundaryIndex - 1] === '/') {
            candidates.push(filePath);
            break;
          }
        }
      }
    }

    if (candidates.length > 0) {
      return candidates;
    }

    // 回退策略：按最后段名匹配，例如 foo/bar -> bar.rb
    const name = modulePath.split('/').at(-1);
    if (!name) return candidates;

    const fallbackSuffixes = [`/${name}.rb`, `/${name}/index.rb`];
    for (const filePath of allFiles) {
      for (const suffix of fallbackSuffixes) {
        if (filePath.endsWith(suffix)) {
          candidates.push(filePath);
          break;
        }
      }
    }

    return candidates;
  }
}
