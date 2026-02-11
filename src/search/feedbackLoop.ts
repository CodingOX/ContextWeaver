import path from 'node:path';
import type Database from 'better-sqlite3';

export type FeedbackSignalType = 'path_pin' | 'anchor_reuse' | 'no_hit_rewrite';

export interface FeedbackSeed {
  chunkId: string;
  filePath: string;
  chunkIndex: number;
  score: number;
  source: string;
}

export interface RetrievalEventInput {
  query: string;
  technicalTerms?: string[];
  seeds: FeedbackSeed[];
  createdAtMs?: number;
}

export interface InferredSignal {
  type: FeedbackSignalType;
  weight: number;
  targetChunkId?: string;
  targetFilePath?: string;
  evidence: string;
}

export interface RecordRetrievalEventResult {
  eventId: number;
  inferredSignals: InferredSignal[];
}

export interface FeedbackSummaryOptions {
  days?: number;
  top?: number;
  nowMs?: number;
}

export interface FeedbackSummary {
  totalEvents: number;
  zeroHitRate: number;
  implicitSuccessRate: number;
  positiveSignals: number;
  negativeSignals: number;
  signalBreakdown: Record<string, number>;
  topFiles: Array<{
    filePath: string;
    hitCount: number;
    totalWeight: number;
  }>;
}

interface EventSnapshot {
  id: number;
  query: string;
  technicalTerms: string[];
  seedCount: number;
  chunks: FeedbackSeed[];
}

function safeParseTerms(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function tokenize(text: string): string[] {
  const tokens = text.toLowerCase().match(/[a-z0-9_]+/g);
  if (!tokens) {
    return [];
  }
  return tokens;
}

function jaccardSimilarity(leftTokens: string[], rightTokens: string[]): number {
  const left = new Set(leftTokens);
  const right = new Set(rightTokens);

  if (left.size === 0 && right.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }

  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function fileStem(filePath: string): string {
  const base = path.basename(filePath);
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  return stem.toLowerCase();
}

function eventToSearchText(event: Pick<EventSnapshot, 'query' | 'technicalTerms'>): string {
  return normalizeText([event.query, ...event.technicalTerms].filter(Boolean).join(' '));
}

function inferSignals(previous: EventSnapshot, current: EventSnapshot): InferredSignal[] {
  const signals: InferredSignal[] = [];

  const currentText = eventToSearchText(current);
  const currentTokens = new Set(tokenize(currentText));

  const seenPathPinKeys = new Set<string>();
  for (const chunk of previous.chunks) {
    const stem = fileStem(chunk.filePath);
    if (!stem) continue;

    const normalizedStem = stem.replace(/[_-]/g, '');
    const tokenHit = currentTokens.has(stem) || currentTokens.has(normalizedStem);
    const textHit = currentText.includes(stem) || currentText.includes(normalizedStem);

    if (!tokenHit && !textHit) {
      continue;
    }

    const dedupKey = `${chunk.filePath}#${chunk.chunkIndex}`;
    if (seenPathPinKeys.has(dedupKey)) {
      continue;
    }
    seenPathPinKeys.add(dedupKey);

    signals.push({
      type: 'path_pin',
      weight: 1,
      targetChunkId: chunk.chunkId,
      targetFilePath: chunk.filePath,
      evidence: JSON.stringify({ stem, matchedBy: tokenHit ? 'token' : 'text' }),
    });
  }

  if (previous.seedCount === 0) {
    const prevText = eventToSearchText(previous);
    const similarity = jaccardSimilarity(tokenize(prevText), Array.from(currentTokens));

    if (similarity >= 0.4) {
      signals.push({
        type: 'no_hit_rewrite',
        weight: -0.6,
        evidence: JSON.stringify({ similarity: Number(similarity.toFixed(4)) }),
      });
    }
  }

  return signals;
}

function getLastEvent(db: Database.Database): EventSnapshot | null {
  const row = db
    .prepare(
      `SELECT id, query, technical_terms, seed_count
       FROM retrieval_events
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get() as
    | {
        id: number;
        query: string;
        technical_terms: string;
        seed_count: number;
      }
    | undefined;

  if (!row) return null;

  const chunks = db
    .prepare(
      `SELECT chunk_id, file_path, chunk_index, score, source
       FROM retrieval_event_chunks
       WHERE event_id = ?
       ORDER BY rank ASC`,
    )
    .all(row.id) as Array<{
    chunk_id: string;
    file_path: string;
    chunk_index: number;
    score: number;
    source: string;
  }>;

  return {
    id: row.id,
    query: row.query,
    technicalTerms: safeParseTerms(row.technical_terms),
    seedCount: row.seed_count,
    chunks: chunks.map((item) => ({
      chunkId: item.chunk_id,
      filePath: item.file_path,
      chunkIndex: item.chunk_index,
      score: item.score,
      source: item.source,
    })),
  };
}

export function ensureFeedbackTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS retrieval_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      query TEXT NOT NULL,
      technical_terms TEXT NOT NULL,
      seed_count INTEGER NOT NULL,
      file_count INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS retrieval_event_chunks (
      event_id INTEGER NOT NULL,
      rank INTEGER NOT NULL,
      chunk_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      score REAL NOT NULL,
      source TEXT NOT NULL,
      PRIMARY KEY(event_id, rank)
    );

    CREATE TABLE IF NOT EXISTS retrieval_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      source_event_id INTEGER NOT NULL,
      target_event_id INTEGER NOT NULL,
      signal_type TEXT NOT NULL,
      weight REAL NOT NULL,
      target_chunk_id TEXT,
      target_file_path TEXT,
      evidence TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_retrieval_events_created_at
      ON retrieval_events(created_at);

    CREATE INDEX IF NOT EXISTS idx_retrieval_chunks_event_id
      ON retrieval_event_chunks(event_id);

    CREATE INDEX IF NOT EXISTS idx_retrieval_signals_created_at
      ON retrieval_signals(created_at);

    CREATE INDEX IF NOT EXISTS idx_retrieval_signals_source_event
      ON retrieval_signals(source_event_id);

    CREATE INDEX IF NOT EXISTS idx_retrieval_signals_target_file
      ON retrieval_signals(target_file_path);
  `);
}

export function recordRetrievalEvent(
  db: Database.Database,
  input: RetrievalEventInput,
): RecordRetrievalEventResult {
  ensureFeedbackTables(db);

  const query = input.query.trim();
  if (!query) {
    throw new Error('query 不能为空');
  }

  const technicalTerms = input.technicalTerms?.map((item) => item.trim()).filter(Boolean) || [];
  const createdAt = input.createdAtMs ?? Date.now();
  const previous = getLastEvent(db);

  const uniqueFiles = new Set(input.seeds.map((seed) => seed.filePath));

  const insertEvent = db.prepare(
    `INSERT INTO retrieval_events(created_at, query, technical_terms, seed_count, file_count)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertChunk = db.prepare(
    `INSERT INTO retrieval_event_chunks(event_id, rank, chunk_id, file_path, chunk_index, score, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertSignal = db.prepare(
    `INSERT INTO retrieval_signals(
      created_at,
      source_event_id,
      target_event_id,
      signal_type,
      weight,
      target_chunk_id,
      target_file_path,
      evidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const eventId = Number(
    insertEvent.run(
      createdAt,
      query,
      JSON.stringify(technicalTerms),
      input.seeds.length,
      uniqueFiles.size,
    ).lastInsertRowid,
  );

  for (let rank = 0; rank < input.seeds.length; rank += 1) {
    const seed = input.seeds[rank];
    insertChunk.run(
      eventId,
      rank,
      seed.chunkId,
      seed.filePath,
      seed.chunkIndex,
      seed.score,
      seed.source,
    );
  }

  const currentSnapshot: EventSnapshot = {
    id: eventId,
    query,
    technicalTerms,
    seedCount: input.seeds.length,
    chunks: input.seeds,
  };

  const inferredSignals = previous ? inferSignals(previous, currentSnapshot) : [];

  for (const signal of inferredSignals) {
    insertSignal.run(
      createdAt,
      previous?.id,
      eventId,
      signal.type,
      signal.weight,
      signal.targetChunkId || null,
      signal.targetFilePath || null,
      signal.evidence,
    );
  }

  return {
    eventId,
    inferredSignals,
  };
}

export function getFeedbackSummary(
  db: Database.Database,
  options: FeedbackSummaryOptions = {},
): FeedbackSummary {
  ensureFeedbackTables(db);

  const days = Number.isFinite(options.days) && (options.days || 0) > 0 ? Math.floor(options.days!) : 7;
  const top = Number.isFinite(options.top) && (options.top || 0) > 0 ? Math.floor(options.top!) : 10;
  const nowMs = options.nowMs ?? Date.now();
  const cutoff = nowMs - days * 24 * 60 * 60 * 1000;

  const totalEvents = (
    db.prepare('SELECT COUNT(*) as c FROM retrieval_events WHERE created_at >= ?').get(cutoff) as {
      c: number;
    }
  ).c;

  const zeroHitEvents = (
    db
      .prepare('SELECT COUNT(*) as c FROM retrieval_events WHERE created_at >= ? AND seed_count = 0')
      .get(cutoff) as { c: number }
  ).c;

  const positiveSignals = (
    db
      .prepare('SELECT COUNT(*) as c FROM retrieval_signals WHERE created_at >= ? AND weight > 0')
      .get(cutoff) as { c: number }
  ).c;

  const negativeSignals = (
    db
      .prepare('SELECT COUNT(*) as c FROM retrieval_signals WHERE created_at >= ? AND weight < 0')
      .get(cutoff) as { c: number }
  ).c;

  const sourceEventsWithPositiveSignals = (
    db
      .prepare(
        'SELECT COUNT(DISTINCT source_event_id) as c FROM retrieval_signals WHERE created_at >= ? AND weight > 0',
      )
      .get(cutoff) as { c: number }
  ).c;

  const topFilesRows = db
    .prepare(
      `SELECT target_file_path as file_path, COUNT(*) as hit_count, SUM(weight) as total_weight
       FROM retrieval_signals
       WHERE created_at >= ?
         AND target_file_path IS NOT NULL
         AND weight > 0
       GROUP BY target_file_path
       ORDER BY total_weight DESC, hit_count DESC, file_path ASC
       LIMIT ?`,
    )
    .all(cutoff, top) as Array<{ file_path: string; hit_count: number; total_weight: number }>;

  const breakdownRows = db
    .prepare(
      `SELECT signal_type, COUNT(*) as c
       FROM retrieval_signals
       WHERE created_at >= ?
       GROUP BY signal_type`,
    )
    .all(cutoff) as Array<{ signal_type: string; c: number }>;

  const signalBreakdown: Record<string, number> = {};
  for (const row of breakdownRows) {
    signalBreakdown[row.signal_type] = row.c;
  }

  return {
    totalEvents,
    zeroHitRate: totalEvents === 0 ? 0 : zeroHitEvents / totalEvents,
    implicitSuccessRate: totalEvents === 0 ? 0 : sourceEventsWithPositiveSignals / totalEvents,
    positiveSignals,
    negativeSignals,
    signalBreakdown,
    topFiles: topFilesRows.map((row) => ({
      filePath: row.file_path,
      hitCount: row.hit_count,
      totalWeight: Number(row.total_weight || 0),
    })),
  };
}
