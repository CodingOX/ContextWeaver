import { DEFAULT_CONFIG } from '../config.js';
import { evaluateBenchmarkCases } from './metrics.js';
import type {
  AutoTuneCase,
  AutoTuneConfig,
  AutoTuneGrid,
  AutoTuneOptions,
  AutoTuneResult,
  BenchmarkCase,
  BenchmarkSummary,
} from './types.js';

const DEFAULT_AUTO_TUNE_GRID: AutoTuneGrid = {
  wVec: [0.5, 0.6, 0.7],
  rrfK0: [10, 20, 40],
  fusedTopM: [40, 60],
};

function normalizeKValues(kValues: number[]): number[] {
  const normalized = kValues
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => Math.floor(value));

  if (normalized.length === 0) {
    throw new Error('kValues 至少需要一个正整数');
  }

  return [...new Set(normalized)].sort((left, right) => left - right);
}

function normalizeGrid(grid?: Partial<AutoTuneGrid>): AutoTuneGrid {
  const merged: AutoTuneGrid = {
    wVec: grid?.wVec && grid.wVec.length > 0 ? grid.wVec : DEFAULT_AUTO_TUNE_GRID.wVec,
    rrfK0: grid?.rrfK0 && grid.rrfK0.length > 0 ? grid.rrfK0 : DEFAULT_AUTO_TUNE_GRID.rrfK0,
    fusedTopM:
      grid?.fusedTopM && grid.fusedTopM.length > 0
        ? grid.fusedTopM
        : DEFAULT_AUTO_TUNE_GRID.fusedTopM,
  };

  for (const value of merged.wVec) {
    if (!Number.isFinite(value) || value <= 0 || value >= 1) {
      throw new Error(`wVec 值非法：${value}，应在 (0, 1) 区间`);
    }
  }

  for (const value of merged.rrfK0) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`rrfK0 值非法：${value}，应为正数`);
    }
  }

  for (const value of merged.fusedTopM) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`fusedTopM 值非法：${value}，应为正数`);
    }
  }

  return {
    wVec: [...new Set(merged.wVec)].sort((left, right) => left - right),
    rrfK0: [...new Set(merged.rrfK0)].sort((left, right) => left - right),
    fusedTopM: [...new Set(merged.fusedTopM)].sort((left, right) => left - right),
  };
}

function fuseRrf(caseItem: AutoTuneCase, config: AutoTuneConfig): string[] {
  const fusedScores = new Map<string, number>();

  for (let rank = 0; rank < caseItem.vectorRetrieved.length; rank += 1) {
    const id = caseItem.vectorRetrieved[rank];
    const score = config.wVec / (config.rrfK0 + rank);
    fusedScores.set(id, (fusedScores.get(id) ?? 0) + score);
  }

  for (let rank = 0; rank < caseItem.lexicalRetrieved.length; rank += 1) {
    const id = caseItem.lexicalRetrieved[rank];
    const score = config.wLex / (config.rrfK0 + rank);
    fusedScores.set(id, (fusedScores.get(id) ?? 0) + score);
  }

  return Array.from(fusedScores.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, config.fusedTopM)
    .map(([id]) => id);
}

function buildBenchmarkCases(cases: AutoTuneCase[], config: AutoTuneConfig): BenchmarkCase[] {
  return cases.map((caseItem) => ({
    id: caseItem.id,
    query: caseItem.query,
    retrieved: fuseRrf(caseItem, config),
    relevant: caseItem.relevant,
  }));
}

function readTargetScore(summary: BenchmarkSummary, target: string): number {
  if (target === 'mrr') {
    return summary.mrr;
  }

  if (target.startsWith('recall@')) {
    const key = target.slice('recall@'.length);
    return summary.recallAtK[key] ?? 0;
  }

  if (target.startsWith('ndcg@')) {
    const key = target.slice('ndcg@'.length);
    return summary.ndcgAtK[key] ?? 0;
  }

  throw new Error(`不支持的 target: ${target}`);
}

function normalizeTarget(target: string, kValues: number[]): string {
  const trimmed = target.trim().toLowerCase();
  if (trimmed === 'mrr') {
    return 'mrr';
  }

  if (/^(recall|ndcg)@\d+$/.test(trimmed)) {
    return trimmed;
  }

  const maxK = kValues[kValues.length - 1];
  if (trimmed === 'recall') {
    return `recall@${maxK}`;
  }

  if (trimmed === 'ndcg') {
    return `ndcg@${maxK}`;
  }

  throw new Error(`不支持的 target: ${target}`);
}

function expandConfigs(grid: AutoTuneGrid): AutoTuneConfig[] {
  const configs: AutoTuneConfig[] = [];

  for (const wVec of grid.wVec) {
    for (const rrfK0 of grid.rrfK0) {
      for (const fusedTopM of grid.fusedTopM) {
        const wLex = Number((1 - wVec).toFixed(6));
        configs.push({
          ...DEFAULT_CONFIG,
          wVec,
          wLex,
          rrfK0,
          fusedTopM,
        });
      }
    }
  }

  return configs;
}

export function runAutoTune(cases: AutoTuneCase[], options: AutoTuneOptions): AutoTuneResult {
  if (cases.length === 0) {
    throw new Error('调参数据集为空');
  }

  const kValues = normalizeKValues(options.kValues);
  const grid = normalizeGrid(options.grid);
  const target = normalizeTarget(options.target, kValues);
  const topN = Number.isFinite(options.topN) && options.topN > 0 ? Math.floor(options.topN) : 5;

  const candidates = expandConfigs(grid).map((config) => {
    const benchmarkCases = buildBenchmarkCases(cases, config);
    const summary = evaluateBenchmarkCases(benchmarkCases, kValues);
    const targetScore = readTargetScore(summary, target);

    return {
      config,
      summary,
      targetScore,
    };
  });

  candidates.sort((left, right) => {
    if (right.targetScore !== left.targetScore) {
      return right.targetScore - left.targetScore;
    }

    if (right.summary.mrr !== left.summary.mrr) {
      return right.summary.mrr - left.summary.mrr;
    }

    return right.config.wVec - left.config.wVec;
  });

  return {
    target,
    kValues,
    totalCandidates: candidates.length,
    best: candidates[0],
    leaderboard: candidates.slice(0, topN),
  };
}
