/**
 * 分片模块入口
 *
 * 导出语义分片相关的所有类型和功能
 */

// 解析器池
export { getParser, isLanguageSupported } from './ParserPool.js';
// 核心类
export { SemanticSplitter } from './SemanticSplitter.js';
// 运行时注册表
export { RuntimeRegistry } from './runtime/RuntimeRegistry.js';

// 类型
export type { ProcessedChunk } from './types.js';
export type { LanguageRuntime } from './runtime/LanguageRuntime.js';
