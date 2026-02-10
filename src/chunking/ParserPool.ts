/**
 * 解析器池管理
 *
 * 按语言缓存 Parser 实例，避免重复初始化。
 * 基于 RuntimeRegistry 调度运行时。
 *
 */
import Parser from 'tree-sitter';
import { BuiltinRuntimeTs25 } from './runtime/BuiltinRuntimeTs25.js';
import { discoverPluginPackages } from './runtime/PluginLoader.js';
import { RuntimeRegistry } from './runtime/RuntimeRegistry.js';

const registry = new RuntimeRegistry();
registry.register(new BuiltinRuntimeTs25());

let runtimeInitializationPromise: Promise<void> | null = null;

const parserLoadingCache: Map<string, Promise<Parser | null>> = new Map();

// 缓存已初始化的解析器
const parserCache: Map<string, Parser> = new Map();

/**
 * 初始化运行时注册表：内置运行时 + 自动发现插件运行时
 */
async function initializeRuntimes(): Promise<void> {
  const pluginRuntimes = await discoverPluginPackages(undefined, {
    suppressMissingModuleError: true,
  });
  for (const runtime of pluginRuntimes) {
    try {
      registry.register(runtime);
    } catch (err) {
      const error = err as { message?: string };
      console.warn(`[ParserPool] 注册插件 runtime 失败(${runtime.id}): ${error.message}`);
    }
  }
}

function ensureRuntimesInitialized(): Promise<void> {
  if (!runtimeInitializationPromise) {
    runtimeInitializationPromise = initializeRuntimes().catch((err) => {
      const error = err as { message?: string };
      console.warn(`[ParserPool] 初始化插件运行时失败: ${error.message}`);
    });
  }

  return runtimeInitializationPromise;
}

function isTreeSitterParser(parser: unknown): parser is Parser {
  if (!parser || typeof parser !== 'object') return false;

  const value = parser as Partial<Parser>;
  return typeof value.parse === 'function' && typeof value.setLanguage === 'function';
}

/**
 * 获取指定语言的解析器
 * @param language 语言标识
 * @returns Parser 实例，如果不支持该语言则返回 null
 */
export async function getParser(language: string): Promise<Parser | null> {
  const cached = parserCache.get(language);
  if (cached) return cached;

  const loading = parserLoadingCache.get(language);
  if (loading) return loading;

  const loadingPromise = (async () => {
    await ensureRuntimesInitialized();

    const runtime = registry.findRuntime(language);
    if (!runtime) return null;

    const parser = await runtime.getParser(language);
    if (!isTreeSitterParser(parser)) {
      if (parser !== null) {
        console.warn(`[ParserPool] runtime(${runtime.id}) 返回了非法 parser，语言=${language}`);
      }
      return null;
    }

    parserCache.set(language, parser);
    return parser;
  })().finally(() => {
    parserLoadingCache.delete(language);
  });

  parserLoadingCache.set(language, loadingPromise);
  return loadingPromise;
}

/**
 * 检查是否支持指定语言
 */
export function isLanguageSupported(language: string): boolean {
  return registry.findRuntime(language) !== null;
}
