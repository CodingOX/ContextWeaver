import path from 'node:path';
import { loadBenchmarkDataset } from './dataset.js';
import { evaluateBenchmarkCases } from './metrics.js';

interface CliOptions {
  datasetPath: string;
  kValues: number[];
}

const DEFAULT_K_VALUES = [1, 3, 5, 10];

function printUsage() {
  process.stdout.write(
    [
      '用法：tsx src/search/eval/runOfflineBenchmark.ts <dataset.(json|jsonl)> [--k 1,3,5,10]',
      '示例：tsx src/search/eval/runOfflineBenchmark.ts tests/benchmark/fixtures/sample-offline-benchmark.jsonl --k 1,3,5',
    ].join('\n'),
  );
  process.stdout.write('\n');
}

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

function parseCliArgs(argv: string[]): CliOptions {
  const args = [...argv];

  if (args.length === 0) {
    throw new Error('缺少数据集路径');
  }

  const datasetPath = args.shift();
  if (!datasetPath || datasetPath.startsWith('-')) {
    throw new Error('请提供数据集文件路径（json/jsonl）');
  }

  let rawKValues: string | undefined;

  while (args.length > 0) {
    const flag = args.shift();

    if (flag === '--k') {
      rawKValues = args.shift();
      continue;
    }

    throw new Error(`未知参数：${flag}`);
  }

  return {
    datasetPath,
    kValues: parseKValues(rawKValues),
  };
}

function formatSummary(
  datasetPath: string,
  summary: ReturnType<typeof evaluateBenchmarkCases>,
  kValues: readonly number[],
): string {
  const lines: string[] = [];
  lines.push('=== Offline Benchmark Summary ===');
  lines.push(`Dataset : ${path.resolve(datasetPath)}`);
  lines.push(`Queries : ${summary.queryCount}`);
  lines.push(`MRR     : ${summary.mrr.toFixed(6)}`);

  for (const k of kValues) {
    const key = String(k);
    lines.push(`Recall@${k}: ${summary.recallAtK[key].toFixed(6)}`);
  }

  for (const k of kValues) {
    const key = String(k);
    lines.push(`nDCG@${k}: ${summary.ndcgAtK[key].toFixed(6)}`);
  }

  return lines.join('\n');
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const dataset = await loadBenchmarkDataset(options.datasetPath);
  const summary = evaluateBenchmarkCases(dataset, options.kValues);

  process.stdout.write(`${formatSummary(options.datasetPath, summary, options.kValues)}\n`);
}

main().catch((error) => {
  process.stderr.write(`离线评测执行失败：${(error as Error).message}\n`);
  printUsage();
  process.exit(1);
});
