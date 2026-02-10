import type { LanguageRuntime } from './LanguageRuntime.js';

export const CORE_PLUGIN_CANDIDATES = [
  '@alistar.max/contextweaver-lang-all',
  '@alistar.max/contextweaver-lang-typescript',
  '@alistar.max/contextweaver-lang-kotlin',
  '@alistar.max/contextweaver-lang-csharp',
  '@alistar.max/contextweaver-lang-cpp',
  '@alistar.max/contextweaver-lang-java',
  '@alistar.max/contextweaver-lang-ruby',
  '@alistar.max/contextweaver-lang-c',
  '@alistar.max/contextweaver-lang-php',
  '@alistar.max/contextweaver-lang-rust',
  '@alistar.max/contextweaver-lang-swift',
] as const;

export const LEGACY_PLUGIN_CANDIDATES = [
  '@alistar.max/contextweaver-lang-ts21',
  '@alistar.max/contextweaver-lang-ts22',
] as const;

export const DEFAULT_PLUGIN_CANDIDATES = [
  ...CORE_PLUGIN_CANDIDATES,
  ...LEGACY_PLUGIN_CANDIDATES,
] as const;

type RuntimeFactory = () => unknown;

export interface PluginLoaderLogger {
  warn: (...args: unknown[]) => void;
}

export interface PluginLoaderOptions {
  logger?: PluginLoaderLogger;
  suppressMissingModuleError?: boolean;
}

/**
 * 动态发现并加载语言插件包。
 *
 * 约定：插件包导出 createRuntime()，返回 LanguageRuntime。
 * 任何包加载失败或接口不符合约定时，仅输出 warn，不抛异常。
 */
export async function discoverPluginPackages(
  candidates: readonly string[] = DEFAULT_PLUGIN_CANDIDATES,
  options: PluginLoaderOptions = {},
): Promise<LanguageRuntime[]> {
  const logger = options.logger ?? console;
  const runtimes: LanguageRuntime[] = [];

  for (const candidate of candidates) {
    const runtime = await loadRuntime(candidate, logger, options.suppressMissingModuleError ?? false);
    if (runtime) {
      runtimes.push(runtime);
    }
  }

  return runtimes;
}

async function loadRuntime(
  candidate: string,
  logger: PluginLoaderLogger,
  suppressMissingModuleError: boolean,
): Promise<LanguageRuntime | null> {
  try {
    const loadedModule = await import(candidate);
    const createRuntime = (loadedModule as { createRuntime?: unknown }).createRuntime;

    if (typeof createRuntime !== 'function') {
      logger.warn(`[PluginLoader] 插件 ${candidate} 未导出 createRuntime()，已忽略`);
      return null;
    }

    const runtime = await Promise.resolve((createRuntime as RuntimeFactory)());

    if (!isLanguageRuntime(runtime)) {
      logger.warn(`[PluginLoader] 插件 ${candidate} 的 runtime 接口不合法，已忽略`);
      return null;
    }

    return runtime;
  } catch (err) {
    if (suppressMissingModuleError && isMissingModuleError(err)) {
      return null;
    }

    const error = err as { message?: string };
    logger.warn(`[PluginLoader] 加载插件 ${candidate} 失败: ${error.message ?? 'unknown error'}`);
    return null;
  }
}

function isMissingModuleError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;

  const error = err as { code?: string; message?: string };
  if (error.code === 'ERR_MODULE_NOT_FOUND') return true;

  return typeof error.message === 'string' && error.message.includes('Cannot find package');
}

function isLanguageRuntime(value: unknown): value is LanguageRuntime {
  if (!value || typeof value !== 'object') return false;

  const runtime = value as Partial<LanguageRuntime>;

  return (
    typeof runtime.id === 'string' &&
    Array.isArray(runtime.languages) &&
    runtime.languages.every((language) => typeof language === 'string') &&
    typeof runtime.canParse === 'function' &&
    typeof runtime.getParser === 'function'
  );
}
