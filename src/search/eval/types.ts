export interface BenchmarkCase {
  id: string;
  query: string;
  retrieved: string[];
  relevant: Record<string, number>;
}

export interface BenchmarkSummary {
  queryCount: number;
  recallAtK: Record<string, number>;
  mrr: number;
  ndcgAtK: Record<string, number>;
}

export interface AutoTuneCase {
  id: string;
  query: string;
  vectorRetrieved: string[];
  lexicalRetrieved: string[];
  relevant: Record<string, number>;
}

export interface AutoTuneGrid {
  wVec: number[];
  rrfK0: number[];
  fusedTopM: number[];
}

export interface AutoTuneConfig {
  wVec: number;
  wLex: number;
  rrfK0: number;
  fusedTopM: number;
}

export interface AutoTuneOptions {
  target: string;
  kValues: number[];
  topN?: number;
  grid?: Partial<AutoTuneGrid>;
}

export interface AutoTuneCandidate {
  config: AutoTuneConfig;
  summary: BenchmarkSummary;
  targetScore: number;
}

export interface AutoTuneResult {
  target: string;
  kValues: number[];
  totalCandidates: number;
  best: AutoTuneCandidate;
  leaderboard: AutoTuneCandidate[];
}
