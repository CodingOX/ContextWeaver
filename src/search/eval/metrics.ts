import type { BenchmarkCase, BenchmarkSummary } from './types.js';

function normalizeK(k: number): number {
  if (!Number.isFinite(k) || k <= 0) {
    return 0;
  }
  return Math.floor(k);
}

function toRelevantSet(relevantIds: Iterable<string>): Set<string> {
  return relevantIds instanceof Set ? relevantIds : new Set(relevantIds);
}

function takeTopUnique(rankedIds: readonly string[], k: number): string[] {
  if (k <= 0 || rankedIds.length === 0) {
    return [];
  }

  const results: string[] = [];
  const seen = new Set<string>();

  for (const id of rankedIds) {
    if (seen.has(id)) {
      continue;
    }

    seen.add(id);
    results.push(id);

    if (results.length >= k) {
      break;
    }
  }

  return results;
}

function toPositiveRelevanceMap(relevanceById: Record<string, number>): Record<string, number> {
  const normalized: Record<string, number> = {};

  for (const [id, gain] of Object.entries(relevanceById)) {
    if (Number.isFinite(gain) && gain > 0) {
      normalized[id] = gain;
    }
  }

  return normalized;
}

export function recallAtK(
  rankedIds: readonly string[],
  relevantIds: Iterable<string>,
  k: number,
): number {
  const normalizedK = normalizeK(k);
  const relevantSet = toRelevantSet(relevantIds);

  if (normalizedK === 0 || relevantSet.size === 0) {
    return 0;
  }

  const topK = takeTopUnique(rankedIds, normalizedK);
  let hits = 0;

  for (const id of topK) {
    if (relevantSet.has(id)) {
      hits += 1;
    }
  }

  return hits / relevantSet.size;
}

export function reciprocalRank(rankedIds: readonly string[], relevantIds: Iterable<string>): number {
  const relevantSet = toRelevantSet(relevantIds);

  if (relevantSet.size === 0) {
    return 0;
  }

  const seen = new Set<string>();
  let uniqueRank = 0;

  for (const id of rankedIds) {
    if (seen.has(id)) {
      continue;
    }

    seen.add(id);
    uniqueRank += 1;

    if (relevantSet.has(id)) {
      return 1 / uniqueRank;
    }
  }

  return 0;
}

export function dcgAtK(
  rankedIds: readonly string[],
  relevanceById: Record<string, number>,
  k: number,
): number {
  const normalizedK = normalizeK(k);
  if (normalizedK === 0) {
    return 0;
  }

  const relevance = toPositiveRelevanceMap(relevanceById);
  const topK = takeTopUnique(rankedIds, normalizedK);

  let dcg = 0;
  for (let index = 0; index < topK.length; index += 1) {
    const gain = relevance[topK[index]] ?? 0;
    if (gain <= 0) {
      continue;
    }

    const discount = Math.log2(index + 2);
    dcg += gain / discount;
  }

  return dcg;
}

export function idealDcgAtK(relevanceById: Record<string, number>, k: number): number {
  const normalizedK = normalizeK(k);
  if (normalizedK === 0) {
    return 0;
  }

  const sortedGains = Object.values(toPositiveRelevanceMap(relevanceById))
    .sort((left, right) => right - left)
    .slice(0, normalizedK);

  let idcg = 0;
  for (let index = 0; index < sortedGains.length; index += 1) {
    const discount = Math.log2(index + 2);
    idcg += sortedGains[index] / discount;
  }

  return idcg;
}

export function ndcgAtK(
  rankedIds: readonly string[],
  relevanceById: Record<string, number>,
  k: number,
): number {
  const idcg = idealDcgAtK(relevanceById, k);
  if (idcg === 0) {
    return 0;
  }

  const dcg = dcgAtK(rankedIds, relevanceById, k);
  return dcg / idcg;
}

function normalizeKList(kValues: readonly number[]): number[] {
  const normalized = new Set<number>();

  for (const value of kValues) {
    const k = normalizeK(value);
    if (k > 0) {
      normalized.add(k);
    }
  }

  return [...normalized].sort((left, right) => left - right);
}

function relevantIdsFromCase(entry: BenchmarkCase): Set<string> {
  return new Set(
    Object.entries(entry.relevant)
      .filter(([, gain]) => Number.isFinite(gain) && gain > 0)
      .map(([id]) => id),
  );
}

export function evaluateBenchmarkCases(
  entries: readonly BenchmarkCase[],
  kValues: readonly number[],
): BenchmarkSummary {
  const ks = normalizeKList(kValues);
  const recallSums: Record<string, number> = {};
  const ndcgSums: Record<string, number> = {};

  for (const k of ks) {
    recallSums[String(k)] = 0;
    ndcgSums[String(k)] = 0;
  }

  if (entries.length === 0) {
    return {
      queryCount: 0,
      recallAtK: recallSums,
      mrr: 0,
      ndcgAtK: ndcgSums,
    };
  }

  let mrrSum = 0;

  for (const entry of entries) {
    const relevantIds = relevantIdsFromCase(entry);
    mrrSum += reciprocalRank(entry.retrieved, relevantIds);

    for (const k of ks) {
      const key = String(k);
      recallSums[key] += recallAtK(entry.retrieved, relevantIds, k);
      ndcgSums[key] += ndcgAtK(entry.retrieved, entry.relevant, k);
    }
  }

  const queryCount = entries.length;
  const recallAtKSummary: Record<string, number> = {};
  const ndcgAtKSummary: Record<string, number> = {};

  for (const k of ks) {
    const key = String(k);
    recallAtKSummary[key] = recallSums[key] / queryCount;
    ndcgAtKSummary[key] = ndcgSums[key] / queryCount;
  }

  return {
    queryCount,
    recallAtK: recallAtKSummary,
    mrr: mrrSum / queryCount,
    ndcgAtK: ndcgAtKSummary,
  };
}
