/**
 * Swift 解析策略 (import/@testable import 解析)
 */

import { commonPrefixLength, type ImportResolver } from './types.js';

const SWIFT_EXTENSION = '.swift';

export class SwiftResolver implements ImportResolver {
  supports(filePath: string): boolean {
    return filePath.endsWith(SWIFT_EXTENSION);
  }

  extract(content: string): string[] {
    const imports: string[] = [];

    // 匹配：
    // - import Foo
    // - import struct Foo.Bar
    // - @testable import Foo
    const pattern =
      /^\s*(?:@testable\s+)?import\s+(?:(?:typealias|struct|class|enum|protocol|let|var|func)\s+)?([\w.]+)\s*;?\s*$/gm;

    for (const match of content.matchAll(pattern)) {
      imports.push(match[1]);
    }

    return imports;
  }

  resolve(importStr: string, currentFile: string, allFiles: Set<string>): string | null {
    const swiftFiles = [...allFiles].filter((filePath) => filePath.endsWith(SWIFT_EXTENSION));
    if (swiftFiles.length === 0) {
      return null;
    }

    // 1. 优先尝试精确路径：Foo.Bar -> /Foo/Bar.swift
    const exactPath = importStr.replace(/\./g, '/');
    const exactSuffix = `/${exactPath}${SWIFT_EXTENSION}`;
    for (const filePath of swiftFiles) {
      if (filePath.endsWith(exactSuffix)) {
        return filePath;
      }
    }

    // 2. 退化为模块级匹配：Foo -> /Foo.swift 或 /Foo/**
    const moduleName = importStr.split('.')[0];
    const moduleFileSuffix = `/${moduleName}${SWIFT_EXTENSION}`;
    const moduleDirMarker = `/${moduleName}/`;
    const candidates: string[] = [];

    for (const filePath of swiftFiles) {
      if (filePath.endsWith(moduleFileSuffix) || filePath.includes(moduleDirMarker)) {
        candidates.push(filePath);
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    if (candidates.length === 1) {
      return candidates[0];
    }

    // 3. 歧义消解：优先选择与当前文件路径前缀重叠最多的
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
}
