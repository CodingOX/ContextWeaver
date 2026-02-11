import path from 'node:path';
import { loadAutoTuneDataset } from './autoTuneDataset.js';
import { runAutoTune } from './autoTune.js';
import type { AutoTuneGrid } from './types.js';

interface CliOptions {
  datasetPath: string;
  target: string;
  kValues: number[];
  topN: number;
  grid?: Partial<AutoTuneGrid>;
}

const DEFAULT_K_VALUES = [1, 3, 5];

function parseKValues(raw: string | undefined): number[] {
  if (!raw) {
    return DEFAULT_K_VALUES;
  }

  const parsed = raw
    .split(',')
    .map((token) => Number(token.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => Math.floor(value));

  if (parsed.length === 0) {
    throw new Error('参数 --k 无效，应为正整数列表，例如 1,3,5');
  }

  return [...new Set(parsed)].sort((left, right) => left - right);
}

function parseGrid(raw: string | undefined): Partial<AutoTuneGrid> | undefined {
  if (!raw) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`参数 --grid 应为 JSON 字符串：${(error as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('参数 --grid 应为对象，例如 {"wVec":[0.5,0.7],"rrfK0":[10,20]}');
  }

  return parsed as Partial<AutoTuneGrid>;
}

function parseCliArgs(argv: string[]): CliOptions {
  const args = [...argv];

  if (args.length === 0) {
    throw new Error('缺少数据集路径');
  }

  const datasetPath = args.shift();
  if (!datasetPath || datasetPath.startsWith('-')) {
    throw new Error('请提供数据集文件路径（json/jsonl）');
  }

  let target = 'mrr';
  let rawKValues: string | undefined;
  let topN = 5;
  let rawGrid: string | undefined;

  while (args.length > 0) {
    const flag = args.shift();

    if (flag === '--target') {
      target = args.shift() || target;
      continue;
    }

    if (flag === '--k') {
      rawKValues = args.shift();
      continue;
    }

    if (flag === '--top') {
      const rawTop = args.shift();
      const parsedTop = Number(rawTop);
      if (!Number.isFinite(parsedTop) || parsedTop <= 0) {
        throw new Error('参数 --top 无效，应为正整数');
      }
      topN = Math.floor(parsedTop);
      continue;
    }

    if (flag === '--grid') {
      rawGrid = args.shift();
      continue;
    }

    throw new Error(`未知参数：${flag}`);
  }

  return {
    datasetPath,
    target,
    kValues: parseKValues(rawKValues),
    topN,
    grid: parseGrid(rawGrid),
  };
}

function printUsage() {
  process.stdout.write(
    [
      '用法：tsx src/search/eval/runAutoTune.ts <dataset.(json|jsonl)> [--target mrr|recall@k|ndcg@k] [--k 1,3,5] [--top 5] [--grid JSON]',
      '示例：tsx src/search/eval/runAutoTune.ts tests/benchmark/fixtures/sample-auto-tune-dataset.jsonl --target mrr --k 1,3,5 --top 3',
    ].join('\n'),
  );
  process.stdout.write('\n');
}

function formatResult(datasetPath: string, result: ReturnType<typeof runAutoTune>): string {
  const lines: string[] = [];

  lines.push('=== Auto Tune Summary ===');
  lines.push(`Dataset       : ${path.resolve(datasetPath)}`);
  lines.push(`Target        : ${result.target}`);
  lines.push(`K Values      : ${result.kValues.join(',')}`);
  lines.push(`Candidates    : ${result.totalCandidates}`);
  lines.push(`Best          : wVec=${result.best.config.wVec}, wLex=${result.best.config.wLex}, rrfK0=${result.best.config.rrfK0}, fusedTopM=${result.best.config.fusedTopM}`);
  lines.push(`Best Score    : ${result.best.targetScore.toFixed(6)}`);
  lines.push(`Best MRR      : ${result.best.summary.mrr.toFixed(6)}`);

  lines.push('--- Leaderboard ---');
  result.leaderboard.forEach((item, index) => {
    lines.push(
      `${index + 1}. score=${item.targetScore.toFixed(6)} | wVec=${item.config.wVec}, wLex=${item.config.wLex}, rrfK0=${item.config.rrfK0}, fusedTopM=${item.config.fusedTopM}`,
    );
  });

  return lines.join('\n');
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const cases = await loadAutoTuneDataset(options.datasetPath);
  const result = runAutoTune(cases, {
    target: options.target,
    kValues: options.kValues,
    topN: options.topN,
    grid: options.grid,
  });

  process.stdout.write(`${formatResult(options.datasetPath, result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`自动调参执行失败：${(error as Error).message}\n`);
  printUsage();
  process.exit(1);
});
