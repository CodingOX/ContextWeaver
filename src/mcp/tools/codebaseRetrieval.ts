/**
 * codebase-retrieval MCP Tool
 *
 * 极简主义 (Zen Design) 代码检索工具
 *
 * 设计理念：
 * - 意图与术语分离：LLM 只需区分"语义意图"和"精确术语"
 * - 黄金默认值：提供同文件上下文，禁止跨文件抓取
 * - 回归代理本能：工具只负责定位，跨文件探索由 Agent 自主发起
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { generateProjectId, initDb } from '../../db/index.js';
import { getAllowedLanguages, getCodeLanguages, isKnownLanguage } from '../../scanner/language.js';
// 注意：SearchService 和 scan 改为延迟导入，避免在 MCP 启动时就加载 native 模块
import { recordRetrievalEvent } from '../../search/feedbackLoop.js';
import { createFilePathFilter, normalizeFilePathFilterConfig } from '../../search/pathFilter.js';
import { buildQueryChannels } from '../../search/queryChannels.js';
import type { ContextPack, ScoredChunk, SearchConfig, Segment } from '../../search/types.js';
import { logger } from '../../utils/logger.js';
import type { ChunkRecord } from '../../vectorStore/index.js';

// 工具 Schema (暴露给 LLM)

export const codebaseRetrievalSchema = z.object({
  repo_path: z
    .string()
    .describe(
      "The absolute file system path to the repository root. (e.g., '/Users/dev/my-project')",
    ),
  information_request: z
    .string()
    .describe(
      "The SEMANTIC GOAL. Describe the functionality, logic, or behavior you are looking for in full natural language sentences. Focus on 'how it works' rather than exact names. (e.g., 'Trace the execution flow of the login process')",
    ),
  technical_terms: z
    .array(z.string())
    .optional()
    .describe(
      'HARD FILTERS. Precise identifiers to narrow down results. Only use symbols KNOWN to exist to avoid false negatives.',
    ),
  response_mode: z
    .enum(['overview', 'raw'])
    .optional()
    .describe(
      "Response format mode. 'overview' returns concise segments. 'raw' runs two-stage retrieval and returns Top-N core raw code blocks.",
    ),
  raw_top_n: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe(
      "Only for response_mode='raw': number of core code blocks to fetch (1-20, default 5).",
    ),
  include_globs: z
    .array(z.string())
    .optional()
    .describe(
      "Optional file path include globs. Only matched files are kept (e.g., ['src/main/java/**']).",
    ),
  exclude_globs: z
    .array(z.string())
    .optional()
    .describe("Optional file path exclude globs. Matched files are removed (e.g., ['zzz/**'])."),
  source_code_only: z
    .boolean()
    .optional()
    .describe(
      'Quick filter: exclude docs/config languages (markdown/json/yaml/toml/xml). Mutually exclusive with include_languages.',
    ),
  include_languages: z
    .array(z.string())
    .optional()
    .describe(
      "Language whitelist: only include specified languages (e.g., ['typescript', 'python']). Mutually exclusive with source_code_only. Unknown languages will cause validation error.",
    ),
  exclude_languages: z
    .array(z.string())
    .optional()
    .describe(
      "Language blacklist: exclude specified languages (e.g., ['markdown', 'json']). Can be combined with source_code_only. Unknown languages will cause validation error.",
    ),
});

export type CodebaseRetrievalInput = z.infer<typeof codebaseRetrievalSchema>;

// 默认配置 (Zen Config)

/**
 * MCP 工具专用配置覆盖
 *
 * 目标：提供足够看懂当前文件的上下文，但不跨文件
 */
const ZEN_CONFIG_OVERRIDE: Partial<SearchConfig> = {
  // E1: 邻居扩展 - 前后看 2 个 chunk，保证代码块完整性
  neighborHops: 2,

  // E2: 面包屑补全 - 必须开启，保证能看到当前方法所属的 Class/Function 定义
  breadcrumbExpandLimit: 3,

  // E3: Import 扩展 - 强制关闭！
  // 理由：跨文件是 Agent 的决策，不要预加载，防止 Token 爆炸
  importFilesPerSeed: 0,
  chunksPerImportFile: 0,
};

// ===========================================
// 自动索引逻辑
// ===========================================

const BASE_DIR = path.join(os.homedir(), '.contextweaver');
const INDEX_LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_RAW_TOP_N = 5;
const MAX_RAW_TOP_N = 20;

/**
 * 语言过滤参数配置
 */
export interface LanguageFilterConfig {
  source_code_only?: boolean;
  include_languages?: string[];
  exclude_languages?: string[];
}

/**
 * 校验语言过滤参数的冲突规则
 * @throws {Error} 参数冲突时抛出错误
 */
export function validateLanguageFilterConflicts(config: LanguageFilterConfig): void {
  const { source_code_only, include_languages, exclude_languages } = config;

  // 规则 1: source_code_only 与 include_languages 互斥
  if (source_code_only && include_languages && include_languages.length > 0) {
    throw new Error('source_code_only 与 include_languages 参数互斥，不可同时使用');
  }

  // 规则 2: include_languages 与 exclude_languages 不能有交集
  if (include_languages && exclude_languages) {
    const intersection = include_languages.filter((lang) => exclude_languages.includes(lang));
    if (intersection.length > 0) {
      throw new Error(`include_languages 与 exclude_languages 有交集: ${intersection.join(', ')}`);
    }
  }
}

/**
 * 校验语言值是否在白名单中
 * @throws {Error} 包含未知语言时抛出错误
 */
export function validateLanguageWhitelist(languages?: string[]): void {
  if (!languages || languages.length === 0) {
    return;
  }

  const allowedSet = new Set([...getAllowedLanguages(), 'unknown']);
  const invalidLangs = languages.filter((lang) => !allowedSet.has(lang));

  if (invalidLangs.length > 0) {
    throw new Error(`未知语言值: ${invalidLangs.join(', ')}`);
  }
}

/**
 * 归一化语言过滤参数为统一的 languageFilter 数组
 * @returns 归一化后的语言过滤列表，undefined 表示无语言过滤
 */
export function normalizeLanguageFilter(config: LanguageFilterConfig): string[] | undefined {
  const { source_code_only, include_languages, exclude_languages } = config;

  // 无任何语言过滤参数
  if (!source_code_only && !include_languages && !exclude_languages) {
    return undefined;
  }

  let result: string[];

  if (source_code_only) {
    // source_code_only: true → 转换为代码类语言白名单
    result = getCodeLanguages();
  } else if (include_languages) {
    // 显式白名单
    result = [...include_languages];
  } else {
    // 仅有 exclude_languages 时，返回 undefined（SearchService 会做反向过滤）
    return undefined;
  }

  // 叠加 exclude_languages（黑名单排除）
  if (exclude_languages && exclude_languages.length > 0) {
    const excludeSet = new Set(exclude_languages);
    result = result.filter((lang) => !excludeSet.has(lang));
  }

  return result.length > 0 ? result : undefined;
}

type ResponseMode = 'overview' | 'raw';

interface ResponseFormatOptions {
  responseMode: ResponseMode;
  rawTopN: number;
  includeGlobs: string[];
  excludeGlobs: string[];
  rawCodeBlocks: RawCodeBlock[];
}

interface RawCodeBlock {
  filePath: string;
  startLine: number;
  endLine: number;
  breadcrumb: string;
  text: string;
  score: number;
  source: ScoredChunk['source'];
}

/**
 * 确保默认 .env 文件存在
 *
 * 如果 ~/.contextweaver/.env 不存在，则创建包含默认配置的文件
 */
async function ensureDefaultEnvFile(): Promise<void> {
  const configDir = BASE_DIR;
  const envFile = path.join(configDir, '.env');

  // 检查文件是否已存在
  if (fs.existsSync(envFile)) {
    return;
  }

  // 创建配置目录
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
    logger.info({ configDir }, '创建配置目录');
  }

  // 写入默认配置
  const defaultEnvContent = `# ContextWeaver 示例环境变量配置文件

# Embedding API 配置（必需）
# 多 key（可选，逗号分隔）。与 EMBEDDINGS_API_KEY 兼容；同时配置时优先使用本项。
# EMBEDDINGS_API_KEYS=key-1,key-2
EMBEDDINGS_API_KEY=your-api-key-here
EMBEDDINGS_BASE_URL=https://api.siliconflow.cn/v1/embeddings
EMBEDDINGS_MODEL=BAAI/bge-m3
EMBEDDINGS_MAX_CONCURRENCY=10
EMBEDDINGS_DIMENSIONS=1024

# Reranker 配置（必需）
# 多 key（可选，逗号分隔）。与 RERANK_API_KEY 兼容；同时配置时优先使用本项。
# RERANK_API_KEYS=key-1,key-2
RERANK_API_KEY=your-api-key-here
RERANK_BASE_URL=https://api.siliconflow.cn/v1/rerank
RERANK_MODEL=BAAI/bge-reranker-v2-m3
RERANK_TOP_N=20

# 索引忽略模式（可选，逗号分隔，默认已包含常见忽略项）
# IGNORE_PATTERNS=.venv,node_modules
`;

  fs.writeFileSync(envFile, defaultEnvContent);
  logger.info({ envFile }, '已创建默认 .env 配置文件');
}

/**
 * 检测代码库是否已初始化（数据库是否存在）
 */
function isProjectIndexed(projectId: string): boolean {
  const dbPath = path.join(BASE_DIR, projectId, 'index.db');
  return fs.existsSync(dbPath);
}

/**
 * 确保代码库已索引
 *
 * 策略：
 * - 如果代码库未初始化（数据库不存在），执行完整索引
 * - 如果已初始化，执行增量索引（只索引变更的文件）
 * - 使用文件锁防止多进程竞态
 *
 * @param repoPath 代码库路径
 * @param projectId 项目 ID
 * @param onProgress 可选的进度回调
 */
async function ensureIndexed(
  repoPath: string,
  projectId: string,
  onProgress?: (current: number, total?: number, message?: string) => void,
): Promise<void> {
  // 延迟导入锁和 scan 函数（避免 MCP 启动时加载 native 模块）
  const { withLock } = await import('../../utils/lock.js');
  const { scan } = await import('../../scanner/index.js');

  await withLock(
    projectId,
    'index',
    async () => {
      const wasIndexed = isProjectIndexed(projectId);

      if (!wasIndexed) {
        logger.info(
          { repoPath, projectId: projectId.slice(0, 10) },
          '代码库未初始化，开始首次索引...',
        );
        onProgress?.(0, 100, '代码库未索引，开始首次索引...');
      } else {
        logger.debug({ projectId: projectId.slice(0, 10) }, '执行增量索引...');
      }

      const startTime = Date.now();
      const stats = await scan(repoPath, { vectorIndex: true, onProgress });
      const elapsed = Date.now() - startTime;

      logger.info(
        {
          projectId: projectId.slice(0, 10),
          isFirstTime: !wasIndexed,
          totalFiles: stats.totalFiles,
          added: stats.added,
          modified: stats.modified,
          deleted: stats.deleted,
          vectorIndex: stats.vectorIndex,
          elapsedMs: elapsed,
        },
        '索引完成',
      );
    },
    INDEX_LOCK_TIMEOUT_MS,
  );
}

// 工具处理函数

/** 进度回调类型 */
export type ProgressCallback = (current: number, total?: number, message?: string) => void;

/**
 * 处理 codebase-retrieval 工具调用
 *
 * @param args 工具输入参数
 * @param configOverride 可选的配置覆盖
 * @param onProgress 可选的进度回调（用于 MCP 进度通知）
 */
export async function handleCodebaseRetrieval(
  args: CodebaseRetrievalInput,
  configOverride: Partial<SearchConfig> = ZEN_CONFIG_OVERRIDE,
  onProgress?: ProgressCallback,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const {
    repo_path,
    information_request,
    technical_terms,
    response_mode,
    raw_top_n,
    include_globs,
    exclude_globs,
    source_code_only,
    include_languages,
    exclude_languages,
  } = args;

  // 早失败：参数冲突检测
  validateLanguageFilterConflicts({ source_code_only, include_languages, exclude_languages });

  // 早失败：语言白名单校验
  validateLanguageWhitelist(include_languages);
  validateLanguageWhitelist(exclude_languages);

  const responseMode = response_mode ?? 'overview';
  const rawTopN = Math.min(Math.max(raw_top_n ?? DEFAULT_RAW_TOP_N, 1), MAX_RAW_TOP_N);
  const normalizedFilterConfig = normalizeFilePathFilterConfig({
    includeGlobs: include_globs,
    excludeGlobs: exclude_globs,
  });
  const filePathFilter = createFilePathFilter(normalizedFilterConfig);

  // 归一化语言过滤参数
  const languageFilter = normalizeLanguageFilter({
    source_code_only,
    include_languages,
    exclude_languages,
  });

  logger.info(
    {
      repo_path,
      information_request,
      technical_terms,
      responseMode,
      rawTopN,
      includeGlobs: normalizedFilterConfig.includeGlobs,
      excludeGlobs: normalizedFilterConfig.excludeGlobs,
      languageFilter,
    },
    'MCP codebase-retrieval 调用开始',
  );

  // 0. 检查必需的环境变量是否已配置（Embedding + Reranker 都是必需的）
  const { checkEmbeddingEnv, checkRerankerEnv } = await import('../../config.js');
  const embeddingCheck = checkEmbeddingEnv();
  const rerankerCheck = checkRerankerEnv();
  const allMissingVars = [...embeddingCheck.missingVars, ...rerankerCheck.missingVars];

  if (allMissingVars.length > 0) {
    logger.warn({ missingVars: allMissingVars }, 'MCP 环境变量未配置');
    // 自动创建默认 .env 文件
    await ensureDefaultEnvFile();
    return formatEnvMissingResponse(allMissingVars);
  }

  // 1. 生成项目 ID（与 CLI 保持一致：路径 + 目录创建时间）
  const projectId = generateProjectId(repo_path);

  // 2. 确保代码库已索引（自动初始化 + 增量更新）
  await ensureIndexed(repo_path, projectId, onProgress);

  // 3. 查询分通道
  const channels = buildQueryChannels({
    informationRequest: information_request,
    technicalTerms: technical_terms,
  });

  logger.info(
    {
      projectId: projectId.slice(0, 10),
      queryChannels: channels,
      zenConfig: configOverride,
      responseMode,
      rawTopN,
      includeGlobs: normalizedFilterConfig.includeGlobs,
      excludeGlobs: normalizedFilterConfig.excludeGlobs,
      languageFilter,
    },
    'MCP 查询构建',
  );

  // 4. 延迟导入 SearchService（避免 MCP 启动时加载 native 模块）
  const { SearchService } = await import('../../search/SearchService.js');

  // 5. 创建 SearchService 实例（使用 Zen Config）
  const service = new SearchService(projectId, repo_path, configOverride);
  await service.init();
  logger.debug('SearchService 初始化完成');

  // 6. 执行搜索
  const contextPack = await service.buildContextPack(channels.rerankQuery, channels, {
    filePathFilter,
    languageFilter,
  });

  // 详细日志：seeds 信息
  if (contextPack.seeds.length > 0) {
    logger.info(
      {
        seeds: contextPack.seeds.map((s) => ({
          file: s.filePath,
          chunk: s.chunkIndex,
          score: s.score.toFixed(4),
          source: s.source,
        })),
      },
      'MCP 搜索 seeds',
    );
  } else {
    logger.warn('MCP 搜索无 seeds 命中');
  }

  // 详细日志：扩展结果
  if (contextPack.expanded.length > 0) {
    logger.debug(
      {
        expandedCount: contextPack.expanded.length,
        expanded: contextPack.expanded.slice(0, 5).map((e) => ({
          file: e.filePath,
          chunk: e.chunkIndex,
          score: e.score.toFixed(4),
        })),
      },
      'MCP 扩展结果 (前5)',
    );
  }

  // 详细日志：打包后的文件段落
  logger.info(
    {
      seedCount: contextPack.seeds.length,
      expandedCount: contextPack.expanded.length,
      fileCount: contextPack.files.length,
      totalSegments: contextPack.files.reduce((acc, f) => acc + f.segments.length, 0),
      files: contextPack.files.map((f) => ({
        path: f.filePath,
        segments: f.segments.length,
        lines: f.segments.map((s) => `L${s.startLine}-${s.endLine}`),
      })),
      timingMs: contextPack.debug?.timingMs,
    },
    'MCP codebase-retrieval 完成',
  );

  // 7. 写入隐式反馈事件（P4）
  try {
    const db = initDb(projectId);
    try {
      const feedback = recordRetrievalEvent(db, {
        query: information_request,
        technicalTerms: technical_terms,
        seeds: contextPack.seeds.map((seed) => ({
          chunkId: seed.record.chunk_id,
          filePath: seed.filePath,
          chunkIndex: seed.chunkIndex,
          score: seed.score,
          source: seed.source,
        })),
      });

      if (feedback.inferredSignals.length > 0) {
        logger.info(
          {
            eventId: feedback.eventId,
            inferredSignals: feedback.inferredSignals.map((signal) => ({
              type: signal.type,
              weight: signal.weight,
              file: signal.targetFilePath,
            })),
          },
          'MCP 隐式反馈信号已记录',
        );
      }
    } finally {
      db.close();
    }
  } catch (err) {
    const error = err as { message?: string };
    logger.warn({ error: error.message }, '写入隐式反馈失败（不影响主流程）');
  }

  // 8. 格式化输出
  let rawCodeBlocks: RawCodeBlock[] = [];
  if (responseMode === 'raw') {
    rawCodeBlocks = await collectRawCodeBlocks(projectId, contextPack.seeds, rawTopN);
  }

  return formatMcpResponse(contextPack, {
    responseMode,
    rawTopN,
    includeGlobs: normalizedFilterConfig.includeGlobs,
    excludeGlobs: normalizedFilterConfig.excludeGlobs,
    rawCodeBlocks,
  });
}

// 响应格式化

/**
 * 格式化为 MCP 响应格式
 */
function formatMcpResponse(
  pack: ContextPack,
  options: ResponseFormatOptions,
): { content: Array<{ type: 'text'; text: string }> } {
  const { files, seeds } = pack;
  const summary = buildSummaryLine(pack, options.responseMode);
  const filterSummary = formatFilterSummary(options.includeGlobs, options.excludeGlobs);

  let body = '';
  if (options.responseMode === 'raw') {
    const seedBlocks = seeds
      .slice(0, options.rawTopN)
      .map(
        (seed, idx) =>
          `${idx + 1}. ${seed.filePath}#${seed.chunkIndex} score=${seed.score.toFixed(4)} source=${seed.source}`,
      )
      .join('\n');
    const rawBlocks =
      options.rawCodeBlocks.length > 0
        ? options.rawCodeBlocks.map((block) => formatRawCodeBlock(block)).join('\n\n---\n\n')
        : '_No raw code blocks found after stage-2 extraction._';

    body = [
      '## Stage 1: Retrieval定位',
      seedBlocks || '_No seeds_',
      '',
      `## Stage 2: Top ${options.rawTopN} 原码块`,
      rawBlocks,
    ].join('\n');
  } else {
    body = files
      .map((file) => {
        const segments = file.segments.map((seg) => formatSegment(seg)).join('\n\n');
        return segments;
      })
      .join('\n\n---\n\n');
  }

  const text = [summary, filterSummary, '', body].filter(Boolean).join('\n');

  return {
    content: [
      {
        type: 'text',
        text,
      },
    ],
  };
}

/**
 * 格式化单个代码段
 */
function formatSegment(seg: Segment): string {
  const lang = detectLanguage(seg.filePath);
  const header = `## ${seg.filePath} (L${seg.startLine}-${seg.endLine})`;
  const breadcrumb = seg.breadcrumb ? `> ${seg.breadcrumb}` : '';
  const code = `\`\`\`${lang}\n${seg.text}\n\`\`\``;

  return [header, breadcrumb, code].filter(Boolean).join('\n');
}

function formatRawCodeBlock(block: RawCodeBlock): string {
  const lang = detectLanguage(block.filePath);
  const header = `## ${block.filePath} (L${block.startLine}-${block.endLine}) score=${block.score.toFixed(4)} source=${block.source}`;
  const breadcrumb = block.breadcrumb ? `> ${block.breadcrumb}` : '';
  const code = `\`\`\`${lang}\n${block.text}\n\`\`\``;
  return [header, breadcrumb, code].filter(Boolean).join('\n');
}

function buildSummaryLine(pack: ContextPack, mode: ResponseMode): string {
  return [
    `Found ${pack.seeds.length} relevant code blocks`,
    `Files: ${pack.files.length}`,
    `Total segments: ${pack.files.reduce((acc, f) => acc + f.segments.length, 0)}`,
    `Mode: ${mode}`,
  ].join(' | ');
}

function formatFilterSummary(includeGlobs: string[], excludeGlobs: string[]): string {
  if (includeGlobs.length === 0 && excludeGlobs.length === 0) {
    return '';
  }

  const includeText = includeGlobs.length > 0 ? includeGlobs.join(', ') : 'none';
  const excludeText = excludeGlobs.length > 0 ? excludeGlobs.join(', ') : 'none';
  return `Filter include: ${includeText} | exclude: ${excludeText}`;
}

/**
 * 根据文件扩展名检测语言
 */
function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    rb: 'ruby',
    php: 'php',
    swift: 'swift',
    kt: 'kotlin',
    scala: 'scala',
    sql: 'sql',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    md: 'markdown',
    toml: 'toml',
  };
  return langMap[ext] || ext || 'plaintext';
}

async function collectRawCodeBlocks(
  projectId: string,
  seeds: ScoredChunk[],
  topN: number,
): Promise<RawCodeBlock[]> {
  if (seeds.length === 0 || topN <= 0) {
    return [];
  }

  const dedupedSeeds: ScoredChunk[] = [];
  const seenSeedKeys = new Set<string>();

  for (const seed of seeds) {
    const breadcrumb = seed.record.breadcrumb || '';
    const key = `${seed.filePath}::${breadcrumb}`;
    if (seenSeedKeys.has(key)) {
      continue;
    }
    seenSeedKeys.add(key);
    dedupedSeeds.push(seed);
  }

  if (dedupedSeeds.length === 0) {
    return [];
  }

  const filePaths = Array.from(new Set(dedupedSeeds.map((seed) => seed.filePath)));
  const db = initDb(projectId);

  try {
    const contentMap = loadFileContents(db, filePaths);

    const { getEmbeddingConfig } = await import('../../config.js');
    const { getVectorStore } = await import('../../vectorStore/index.js');
    const vectorStore = await getVectorStore(projectId, getEmbeddingConfig().dimensions);
    const chunksByFile = await vectorStore.getFilesChunks(filePaths);

    const rawBlocks: RawCodeBlock[] = [];
    const seenBlockKeys = new Set<string>();

    for (const seed of dedupedSeeds) {
      if (rawBlocks.length >= topN) break;

      const fileContent = contentMap.get(seed.filePath);
      if (!fileContent) continue;

      const fileChunks = chunksByFile.get(seed.filePath) ?? [];
      const range = resolveRawRange(seed, fileChunks, fileContent.length);
      const text = fileContent.slice(range.start, range.end);
      if (!text.trim()) continue;

      const blockKey = `${seed.filePath}:${range.start}:${range.end}`;
      if (seenBlockKeys.has(blockKey)) {
        continue;
      }
      seenBlockKeys.add(blockKey);

      rawBlocks.push({
        filePath: seed.filePath,
        startLine: offsetToLine(fileContent, range.start),
        endLine: offsetToLine(fileContent, range.end),
        breadcrumb: seed.record.breadcrumb,
        text,
        score: seed.score,
        source: seed.source,
      });
    }

    return rawBlocks;
  } finally {
    db.close();
  }
}

function loadFileContents(db: ReturnType<typeof initDb>, filePaths: string[]): Map<string, string> {
  const map = new Map<string, string>();
  if (filePaths.length === 0) {
    return map;
  }

  const placeholders = filePaths.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT path, content FROM files WHERE path IN (${placeholders})`)
    .all(...filePaths) as Array<{ path: string; content: string }>;

  for (const row of rows) {
    map.set(row.path, row.content);
  }

  return map;
}

function resolveRawRange(
  seed: ScoredChunk,
  fileChunks: ChunkRecord[],
  contentLength: number,
): { start: number; end: number } {
  const breadcrumb = seed.record.breadcrumb;
  if (!breadcrumb || fileChunks.length === 0) {
    return clampRange(seed.record.raw_start, seed.record.raw_end, contentLength);
  }

  const idx = fileChunks.findIndex((chunk) => chunk.chunk_index === seed.chunkIndex);
  if (idx === -1) {
    return clampRange(seed.record.raw_start, seed.record.raw_end, contentLength);
  }

  let left = idx;
  while (left > 0 && fileChunks[left - 1].breadcrumb === breadcrumb) {
    left--;
  }

  let right = idx;
  while (right < fileChunks.length - 1 && fileChunks[right + 1].breadcrumb === breadcrumb) {
    right++;
  }

  const groupedChunks = fileChunks.slice(left, right + 1);
  const start = Math.min(...groupedChunks.map((chunk) => chunk.raw_start));
  const end = Math.max(...groupedChunks.map((chunk) => chunk.raw_end));
  return clampRange(start, end, contentLength);
}

function clampRange(
  start: number,
  end: number,
  contentLength: number,
): { start: number; end: number } {
  const safeStart = Math.max(0, Math.min(start, contentLength));
  const safeEnd = Math.max(safeStart, Math.min(end, contentLength));
  return { start: safeStart, end: safeEnd };
}

function offsetToLine(content: string, offset: number): number {
  let line = 1;
  const max = Math.min(offset, content.length);
  for (let i = 0; i < max; i++) {
    if (content[i] === '\n') {
      line++;
    }
  }
  return line;
}

/**
 * 格式化环境变量缺失的响应
 *
 * 当用户未配置必需的环境变量时，返回友好的提示信息
 */
function formatEnvMissingResponse(missingVars: string[]): {
  content: Array<{ type: 'text'; text: string }>;
} {
  const configPath = '~/.contextweaver/.env';

  const text = `## ⚠️ 配置缺失

ContextWeaver 需要配置 Embedding API 才能工作。

### 缺失的环境变量
${missingVars.map((v) => `- \`${v}\``).join('\n')}

### 配置步骤

已自动创建配置文件：\`${configPath}\`

请编辑该文件，填写你的 API Key：

\`\`\`bash
# Embedding API 配置（必需）
# 推荐使用 KEYS（逗号分隔多 key），方便后期扩展限速轮转
EMBEDDINGS_API_KEYS=your-api-key-here
# 单 key 兼容写法（同时配置时 KEYS 优先）
# EMBEDDINGS_API_KEY=your-api-key-here

# Reranker 配置（必需）
# 推荐使用 KEYS（逗号分隔多 key），方便后期扩展限速轮转
RERANK_API_KEYS=your-api-key-here
# 单 key 兼容写法（同时配置时 KEYS 优先）
# RERANK_API_KEY=your-api-key-here
\`\`\`

保存文件后重新调用此工具即可。
`;

  return {
    content: [
      {
        type: 'text',
        text,
      },
    ],
  };
}
