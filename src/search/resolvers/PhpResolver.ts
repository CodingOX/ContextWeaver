/**
 * PHP 解析策略 (use 语句解析 + 命名空间路径后缀匹配)
 */

import { commonPrefixLength, type ImportResolver } from './types.js';

export class PhpResolver implements ImportResolver {
  supports(filePath: string): boolean {
    return filePath.endsWith('.php');
  }

  extract(content: string): string[] {
    const imports: string[] = [];

    // 匹配：
    // - use Foo\Bar;
    // - use Foo\Bar as Baz;
    // - use Foo\{A,B};
    // - use function Foo\bar;
    // - use const Foo\BAR;
    const usePattern = /^\s*use\s+(?:(function|const)\s+)?([^;]+);/gm;

    for (const match of content.matchAll(usePattern)) {
      const useBody = match[2]?.trim();
      if (!useBody) continue;

      for (const importPath of this.expandUseBody(useBody)) {
        const normalized = importPath.replace(/^\\+/, '').trim();
        if (normalized) {
          imports.push(normalized);
        }
      }
    }

    return imports;
  }

  resolve(importStr: string, currentFile: string, allFiles: Set<string>): string | null {
    // PHP 命名空间：Foo\Bar -> Foo/Bar.php
    const normalized = importStr.replace(/^\\+/, '').replace(/\\/g, '/');
    if (!normalized) return null;

    const candidates = this.collectCandidates(normalized, allFiles);
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

  private expandUseBody(useBody: string): string[] {
    // 处理分组导入：Foo\{A,B as C}
    const groupedMatch = useBody.match(/^(.*?)\\\s*\{([^}]+)\}$/);
    if (groupedMatch) {
      const prefix = groupedMatch[1].trim().replace(/\s+/g, '');
      const members = groupedMatch[2]
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);

      const expanded: string[] = [];
      for (const member of members) {
        const memberPath = this.stripAlias(member).replace(/\s+/g, '');
        if (memberPath) {
          expanded.push(`${prefix}\\${memberPath}`);
        }
      }
      return expanded;
    }

    // 处理逗号分隔导入：use Foo\A, Foo\B as C;
    return useBody
      .split(',')
      .map((part) => this.stripAlias(part.trim()).replace(/\s+/g, ''))
      .filter(Boolean);
  }

  private stripAlias(importClause: string): string {
    // 去掉 as 别名部分，仅保留真实命名空间路径
    return importClause.split(/\s+as\s+/i)[0].trim();
  }

  private collectCandidates(modulePath: string, allFiles: Set<string>): string[] {
    const candidates: string[] = [];
    const suffixes = [`/${modulePath}.php`, `/${modulePath}/index.php`];

    for (const filePath of allFiles) {
      for (const suffix of suffixes) {
        if (filePath.endsWith(suffix)) {
          candidates.push(filePath);
          break;
        }
      }
    }

    if (candidates.length > 0) {
      return candidates;
    }

    // 回退策略：按最后一个段名匹配（如 Foo\Bar -> Bar.php）
    const segments = modulePath.split('/');
    const name = segments[segments.length - 1];
    if (!name) return candidates;

    const fallbackSuffixes = [`/${name}.php`, `/${name}/index.php`];
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
