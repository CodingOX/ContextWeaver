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
