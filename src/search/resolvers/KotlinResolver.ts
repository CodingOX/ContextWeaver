/**
 * Kotlin 解析策略 (包路径后缀匹配)
 */

import type { ImportResolver } from './types.js';

export class KotlinResolver implements ImportResolver {
  supports(filePath: string): boolean {
    return filePath.endsWith('.kt');
  }

  extract(content: string): string[] {
    const imports: string[] = [];

    // 匹配：
    // - import a.b.C
    // - import a.b.*
    // - import a.b.C as Alias
    const pattern = /^\s*import\s+([\w.]+(?:\.\*|\.[A-Z]\w*))(?:\s+as\s+\w+)?\s*$/gm;

    for (const match of content.matchAll(pattern)) {
      imports.push(match[1]);
    }

    return imports;
  }

  resolve(importStr: string, _currentFile: string, allFiles: Set<string>): string | null {
    // 通配符导入：import a.b.*
    if (importStr.endsWith('.*')) {
      const pkgPath = importStr.slice(0, -2).replace(/\./g, '/');
      const suffix = `/${pkgPath}/`;

      for (const filePath of allFiles) {
        if (filePath.endsWith('.kt') && filePath.includes(suffix)) {
          return filePath;
        }
      }

      return null;
    }

    // 普通导入：import a.b.C
    const classPath = importStr.replace(/\./g, '/');
    const suffix = `/${classPath}.kt`;

    for (const filePath of allFiles) {
      if (filePath.endsWith(suffix)) {
        return filePath;
      }
    }

    return null;
  }
}
