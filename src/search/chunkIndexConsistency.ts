import type Database from 'better-sqlite3';
import { getEmbeddingConfig } from '../config.js';
import { initDb } from '../db/index.js';
import { getVectorStore } from '../vectorStore/index.js';
import { batchDeleteChunkFtsByIds, getAllChunkFtsIds, initChunksFts } from './fts.js';

export interface ChunkIndexConsistencyReport {
  vectorCount: number;
  ftsCount: number;
  missingInFts: string[];
  missingInVector: string[];
}

export interface ChunkIndexConsistencyFixResult {
  removedFromFts: number;
}

export function buildChunkIndexConsistencyReport(
  vectorIds: string[],
  ftsIds: string[],
): ChunkIndexConsistencyReport {
  const vectorSet = new Set(vectorIds);
  const ftsSet = new Set(ftsIds);

  const missingInFts = vectorIds.filter((id) => !ftsSet.has(id));
  const missingInVector = ftsIds.filter((id) => !vectorSet.has(id));

  return {
    vectorCount: vectorIds.length,
    ftsCount: ftsIds.length,
    missingInFts,
    missingInVector,
  };
}

export async function inspectChunkIndexConsistency(
  projectId: string,
): Promise<ChunkIndexConsistencyReport> {
  const embeddingConfig = getEmbeddingConfig();
  const vectorStore = await getVectorStore(projectId, embeddingConfig.dimensions);
  const db = initDb(projectId);

  try {
    initChunksFts(db);

    const [vectorIds, ftsIds] = await Promise.all([vectorStore.getAllChunkIds(), getFtsChunkIds(db)]);

    return buildChunkIndexConsistencyReport(vectorIds, ftsIds);
  } finally {
    db.close();
  }
}

export async function repairChunkIndexConsistency(
  projectId: string,
): Promise<ChunkIndexConsistencyFixResult> {
  const report = await inspectChunkIndexConsistency(projectId);
  if (report.missingInVector.length === 0) {
    return { removedFromFts: 0 };
  }

  const db = initDb(projectId);
  try {
    initChunksFts(db);
    batchDeleteChunkFtsByIds(db, report.missingInVector);
    return { removedFromFts: report.missingInVector.length };
  } finally {
    db.close();
  }
}

function getFtsChunkIds(db: Database.Database): string[] {
  return getAllChunkFtsIds(db);
}
