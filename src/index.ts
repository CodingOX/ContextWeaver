#!/usr/bin/env node
// 配置必须最先加载（包含环境变量初始化）
import './config.js';

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cac from 'cac';
import { generateProjectId } from './db/index.js';
import { type ScanStats, scan } from './scanner/index.js';
import {
  inspectChunkIndexConsistency,
  repairChunkIndexConsistency,
} from './search/chunkIndexConsistency.js';
import { logger } from './utils/logger.js';

// 读取 package.json 获取版本号
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgPath = path.resolve(__dirname, '../package.json');
const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));

const cli = cac('contextweaver');

// 自定义版本输出，只显示版本号
if (process.argv.includes('-v') || process.argv.includes('--version')) {
  console.log(pkg.version);
  process.exit(0);
}

cli.command('init', '初始化 ContextWeaver 配置').action(async () => {
  const configDir = path.join(os.homedir(), '.contextweaver');
  const envFile = path.join(configDir, '.env');

  logger.info('开始初始化 ContextWeaver...');

  // 创建配置目录
  try {
    await fs.mkdir(configDir, { recursive: true });
    logger.info(`创建配置目录: ${configDir}`);
  } catch (err) {
    const error = err as { code?: string; message?: string; stack?: string };
    if (error.code !== 'EEXIST') {
      logger.error({ err, stack: error.stack }, `创建配置目录失败: ${error.message}`);
      process.exit(1);
    }
    logger.info(`配置目录已存在: ${configDir}`);
  }

  // 检查是否已存在 .env 文件
  try {
    await fs.access(envFile);
    logger.warn(`.env 文件已存在: ${envFile}`);
    logger.info('初始化完成！');
    return;
  } catch {
    // 文件不存在，继续创建
  }

  // 写入默认 .env 配置
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
  try {
    await fs.writeFile(envFile, defaultEnvContent);
    logger.info(`创建 .env 文件: ${envFile}`);
  } catch (err) {
    const error = err as { message?: string; stack?: string };
    logger.error({ err, stack: error.stack }, `创建 .env 文件失败: ${error.message}`);
    process.exit(1);
  }

  logger.info('下一步操作:');
  logger.info(`   1. 编辑配置文件: ${envFile}`);
  logger.info('   2. 填写你的 API Key 和其他配置');
  logger.info('初始化完成！');
});

cli
  .command('index [path]', '扫描代码库并建立索引')
  .option('-f, --force', '强制重新索引')
  .action(async (targetPath: string | undefined, options: { force?: boolean }) => {
    const rootPath = targetPath ? path.resolve(targetPath) : process.cwd();
    const projectId = generateProjectId(rootPath);

    logger.info(`开始扫描: ${rootPath}`);
    logger.info(`项目 ID: ${projectId}`);
    if (options.force) {
      logger.info('强制重新索引: 是');
    }

    const startTime = Date.now();

    try {
      const { withLock } = await import('./utils/lock.js');

      // 进度日志节流：只在 30%、60%、90% 时输出（100% 由扫描完成日志代替）
      let lastLoggedPercent = 0;
      const stats: ScanStats = await withLock(
        projectId,
        'index',
        async () =>
          scan(rootPath, {
            force: options.force,
            onProgress: (current, total, message) => {
              if (total !== undefined) {
                const percent = Math.floor((current / total) * 100);
                if (percent >= lastLoggedPercent + 30 && percent < 100) {
                  logger.info(`索引进度: ${percent}% - ${message || ''}`);
                  lastLoggedPercent = Math.floor(percent / 30) * 30;
                }
              }
            },
          }),
        10 * 60 * 1000,
      );

      process.stdout.write('\n');

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      logger.info(`索引完成 (${duration}s)`);
      logger.info(
        `总数:${stats.totalFiles} 新增:${stats.added} 修改:${stats.modified} 未变:${stats.unchanged} 删除:${stats.deleted} 跳过:${stats.skipped} 错误:${stats.errors}`,
      );
    } catch (err) {
      const error = err as { message?: string; stack?: string };
      logger.error({ err, stack: error.stack }, `索引失败: ${error.message}`);
      process.exit(1);
    }
  });

cli.command('mcp', '启动 MCP 服务器').action(async () => {
  // 动态导入并启动 MCP 服务器
  const { startMcpServer } = await import('./mcp/server.js');
  try {
    await startMcpServer();
  } catch (err) {
    const error = err as { message?: string; stack?: string };
    logger.error(
      { error: error.message, stack: error.stack },
      `MCP 服务器启动失败: ${error.message}`,
    );
    process.exit(1);
  }
});

cli
  .command('search', '本地检索（参数对齐 MCP）')
  .option('--repo-path <path>', '代码库根目录（默认当前目录）')
  .option('--information-request <text>', '自然语言问题描述（必填）')
  .option('--technical-terms <terms>', '精确术语（逗号分隔）')
  .option('--zen', '使用 MCP Zen 配置（默认开启）')
  .action(
    async (options: {
      repoPath?: string;
      informationRequest?: string;
      technicalTerms?: string;
      zen?: boolean;
    }) => {
      const repoPath = options.repoPath ? path.resolve(options.repoPath) : process.cwd();
      const informationRequest = options.informationRequest;
      if (!informationRequest) {
        logger.error('缺少 --information-request');
        process.exit(1);
      }

      const technicalTerms = (options.technicalTerms || '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      const useZen = options.zen !== false;

      const { handleCodebaseRetrieval } = await import('./mcp/tools/codebaseRetrieval.js');

      const response = await handleCodebaseRetrieval(
        {
          repo_path: repoPath,
          information_request: informationRequest,
          technical_terms: technicalTerms.length > 0 ? technicalTerms : undefined,
        },
        useZen ? undefined : {},
      );

      const text = response.content.map((item) => item.text).join('\n');
      process.stdout.write(`${text}\n`);
    },
  );


cli
  .command('tune <dataset>', '离线自动调参（RRF 回放）')
  .option('--target <metric>', '优化目标（mrr / recall@k / ndcg@k）', { default: 'mrr' })
  .option('--k <values>', '指标 K 列表（逗号分隔）', { default: '1,3,5' })
  .option('--top <n>', '输出前 N 组候选', { default: '5' })
  .option('--grid <json>', '参数网格 JSON（可选）')
  .action(
    async (
      dataset: string,
      options: {
        target?: string;
        k?: string;
        top?: string;
        grid?: string;
      },
    ) => {
      try {
        const { loadAutoTuneDataset } = await import('./search/eval/autoTuneDataset.js');
        const { runAutoTune } = await import('./search/eval/autoTune.js');

        const kValues = (options.k || '1,3,5')
          .split(',')
          .map((token) => Number(token.trim()))
          .filter((value) => Number.isFinite(value) && value > 0)
          .map((value) => Math.floor(value));

        if (kValues.length === 0) {
          throw new Error('--k 参数无效，应为正整数列表（如 1,3,5）');
        }

        let parsedGrid: unknown;
        if (options.grid) {
          parsedGrid = JSON.parse(options.grid);
        }

        const cases = await loadAutoTuneDataset(dataset);
        const result = runAutoTune(cases, {
          target: options.target || 'mrr',
          kValues,
          topN: Number(options.top || '5'),
          grid:
            parsedGrid && typeof parsedGrid === 'object' && !Array.isArray(parsedGrid)
              ? (parsedGrid as { wVec?: number[]; rrfK0?: number[]; fusedTopM?: number[] })
              : undefined,
        });

        logger.info(`自动调参完成: candidates=${result.totalCandidates}, target=${result.target}`);
        logger.info(
          `最佳参数: wVec=${result.best.config.wVec}, wLex=${result.best.config.wLex}, rrfK0=${result.best.config.rrfK0}, fusedTopM=${result.best.config.fusedTopM}, score=${result.best.targetScore.toFixed(6)}`,
        );

        process.stdout.write('=== Auto Tune Leaderboard ===\n');
        result.leaderboard.forEach((item, index) => {
          process.stdout.write(
            `${index + 1}. score=${item.targetScore.toFixed(6)} | wVec=${item.config.wVec}, wLex=${item.config.wLex}, rrfK0=${item.config.rrfK0}, fusedTopM=${item.config.fusedTopM}\n`,
          );
        });
      } catch (err) {
        const error = err as { message?: string; stack?: string };
        logger.error({ err, stack: error.stack }, `自动调参失败: ${error.message}`);
        process.exit(1);
      }
    },
  );


cli
  .command('feedback [path]', '查看检索隐式反馈闭环摘要')
  .option('--days <n>', '统计最近 N 天（默认 7）', { default: '7' })
  .option('--top <n>', '展示前 N 个高复用文件（默认 10）', { default: '10' })
  .action(async (targetPath: string | undefined, options: { days?: string; top?: string }) => {
    const rootPath = targetPath ? path.resolve(targetPath) : process.cwd();
    const projectId = generateProjectId(rootPath);

    const days = Math.max(1, Math.floor(Number(options.days || '7')));
    const top = Math.max(1, Math.floor(Number(options.top || '10')));

    try {
      const { initDb } = await import('./db/index.js');
      const { getFeedbackSummary } = await import('./search/feedbackLoop.js');

      const db = initDb(projectId);
      try {
        const summary = getFeedbackSummary(db, { days, top });

        logger.info(
          `反馈摘要: events=${summary.totalEvents}, zeroHitRate=${summary.zeroHitRate.toFixed(4)}, implicitSuccessRate=${summary.implicitSuccessRate.toFixed(4)}, positiveSignals=${summary.positiveSignals}, negativeSignals=${summary.negativeSignals}`,
        );

        process.stdout.write('=== Retrieval Feedback Summary ===\n');
        process.stdout.write(`projectId: ${projectId}\n`);
        process.stdout.write(`days: ${days}\n`);
        process.stdout.write(`totalEvents: ${summary.totalEvents}\n`);
        process.stdout.write(`zeroHitRate: ${summary.zeroHitRate.toFixed(6)}\n`);
        process.stdout.write(`implicitSuccessRate: ${summary.implicitSuccessRate.toFixed(6)}\n`);
        process.stdout.write(`positiveSignals: ${summary.positiveSignals}\n`);
        process.stdout.write(`negativeSignals: ${summary.negativeSignals}\n`);

        if (summary.topFiles.length > 0) {
          process.stdout.write('--- topFiles ---\n');
          summary.topFiles.forEach((item, index) => {
            process.stdout.write(
              `${index + 1}. ${item.filePath} | hits=${item.hitCount} | weight=${item.totalWeight.toFixed(4)}\n`,
            );
          });
        }
      } finally {
        db.close();
      }
    } catch (err) {
      const error = err as { message?: string; stack?: string };
      logger.error({ err, stack: error.stack }, `反馈摘要查询失败: ${error.message}`);
      process.exit(1);
    }
  });

cli
  .command('doctor [path]', '检查向量索引与 chunks_fts 一致性')
  .option('--repair', '删除 chunks_fts 中无对应向量的孤儿记录')
  .action(async (targetPath: string | undefined, options: { repair?: boolean }) => {
    const rootPath = targetPath ? path.resolve(targetPath) : process.cwd();
    const projectId = generateProjectId(rootPath);

    logger.info(`开始一致性检查: ${rootPath}`);
    logger.info(`项目 ID: ${projectId}`);

    try {
      const report = await inspectChunkIndexConsistency(projectId);

      logger.info(
        `一致性报告: vector=${report.vectorCount}, chunks_fts=${report.ftsCount}, missingInFts=${report.missingInFts.length}, missingInVector=${report.missingInVector.length}`,
      );

      if (report.missingInFts.length > 0) {
        logger.warn(
          `检测到 ${report.missingInFts.length} 条向量记录未进入 chunks_fts（建议执行 contextweaver index --force 或增量索引）`,
        );
      }

      if (report.missingInVector.length > 0) {
        logger.warn(`检测到 ${report.missingInVector.length} 条 chunks_fts 孤儿记录`);
      }

      if (options.repair) {
        const fix = await repairChunkIndexConsistency(projectId);
        logger.info(`修复完成: 已删除 ${fix.removedFromFts} 条 chunks_fts 孤儿记录`);
      }
    } catch (err) {
      const error = err as { message?: string; stack?: string };
      logger.error({ err, stack: error.stack }, `一致性检查失败: ${error.message}`);
      process.exit(1);
    }
  });

cli.help();
cli.parse();
