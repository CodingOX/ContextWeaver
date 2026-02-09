/**
 * Dart 解析策略 (import/export/part/part of 相对路径解析)
 */

import type { ImportResolver } from './types.js';

const DART_EXTENSION = '.dart';

export class DartResolver implements ImportResolver {
  supports(filePath: string): boolean {
    return filePath.endsWith(DART_EXTENSION);
  }

  extract(content: string): string[] {
    const imports: string[] = [];

    // 匹配：
    // - import './x.dart';
    // - export '../x.dart';
    // - part './x.dart';
    // - part of '../x.dart';
    // 仅提取相对路径（./ 或 ../）
    const pattern = /^\s*(?:import|export|part(?:\s+of)?)\s+['"](\.{1,2}\/[^'"]+)['"][^\n;]*;?/gm;

    for (const match of content.matchAll(pattern)) {
      imports.push(match[1]);
    }

    return imports;
  }

  resolve(importStr: string, currentFile: string, allFiles: Set<string>): string | null {
    if (!importStr.startsWith('.')) {
      return null;
    }

    const normalizedPath = this.resolveRelativePath(importStr, currentFile);
    if (!normalizedPath) {
      return null;
    }

    if (allFiles.has(normalizedPath)) {
      return normalizedPath;
    }

    // 兜底：允许缺省扩展名的情况
    if (!normalizedPath.endsWith(DART_EXTENSION)) {
      const pathWithExt = `${normalizedPath}${DART_EXTENSION}`;
      if (allFiles.has(pathWithExt)) {
        return pathWithExt;
      }
    }

    return null;
  }

  /**
   * 解析相对路径并规范化为仓库内统一路径格式
   */
  private resolveRelativePath(importStr: string, currentFile: string): string | null {
    const currentDir = currentFile.split('/').slice(0, -1);
    const parts = [...currentDir, ...importStr.split('/')];
    const resolvedParts: string[] = [];

    for (const part of parts) {
      if (!part || part === '.') {
        continue;
      }

      if (part === '..') {
        if (resolvedParts.length === 0) {
          return null;
        }
        resolvedParts.pop();
        continue;
      }

      resolvedParts.push(part);
    }

    return resolvedParts.join('/');
  }
}
