/**
 * Indexer Service - 向量索引编排层
 *
 * 负责协调 chunking → embedding → 写入 LanceDB 的完整流程
 * 核心特性：
 * - 自愈机制：检测 vector_index_hash != hash 的文件进行补索引
 * - 单调版本更新：先插入新版本再删除旧版本，避免缺失窗口
 * - 批量处理：优化 embedding API 调用
 */

import type Database from 'better-sqlite3';
import { type EmbeddingClient, getEmbeddingClient } from '../api/embedding.js';
import type { ProcessedChunk } from '../chunking/types.js';
import { batchUpdateVectorIndexHash, clearVectorIndexHash } from '../db/index.js';
import type { ProcessResult } from '../scanner/processor.js';
import {
  batchDeleteFileChunksFts,
  batchUpsertChunkFts,
  type ChunkFtsDoc,
  isChunksFtsInitialized,
} from '../search/fts.js';
import { logger } from '../utils/logger.js';
import {
  type ChunkRecord,
  getVectorStore,
  VectorStore,
  type VectorStore as VectorStoreInstance,
} from '../vectorStore/index.js';

// ===========================================
// 类型定义
// ===========================================

/** 索引统计 */
export interface IndexStats {
  indexed: number;
  deleted: number;
  errors: number;
  skipped: number;
}

/** 索引文件信息 */
export interface FileToIndex {
  path: string;
  hash: string;
  chunks: ProcessedChunk[];
}

export interface ChunkFtsDocInput {
  chunkId: string;
  filePath: string;
  chunkIndex: number;
  breadcrumb: string;
  displayCode: string;
  language?: string;
}

/** 每批最多处理的 Chunk 数（控制单批 API 并发请求数 ≤ 20） */
export const BATCH_CHUNKS = 400;

/**
 * 按 Chunk 数动态分组文件列表
 *
 * 目标：控制每批 Embedding 请求的并发数在可控范围。
 * BATCH_CHUNKS=400 → 每批最多 20 个 API 并发请求 (400÷20 chunk/req)。
 */
export function splitIntoChunkBatches(files: FileToIndex[], maxChunks: number): FileToIndex[][] {
  const batches: FileToIndex[][] = [];
  let current: FileToIndex[] = [];
  let currentChunkCount = 0;

  for (const file of files) {
    if (currentChunkCount + file.chunks.length > maxChunks && current.length > 0) {
      batches.push(current);
      current = [file];
      currentChunkCount = file.chunks.length;
    } else {
      current.push(file);
      currentChunkCount += file.chunks.length;
    }
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
}

const CODE_IDENTIFIER_REGEX = /[A-Za-z_][A-Za-z0-9_]*/g;
const BLOCK_COMMENT_REGEX = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_REGEX = /\/\/.*$/gm;
const HASH_COMMENT_REGEX = /(^|\s)#.*$/gm;

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

function toCamelCase(value: string): string {
  return value.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function expandSymbolToken(token: string): string[] {
  const variants = new Set<string>();
  variants.add(token);
  variants.add(token.toLowerCase());

  if (/[a-z][A-Z]/.test(token)) {
    variants.add(toSnakeCase(token));
  }

  if (token.includes('_')) {
    variants.add(toCamelCase(token));
  }

  return Array.from(variants).filter(Boolean);
}

function collectSymbolTokens(text: string): string[] {
  const tokens = new Set<string>();

  for (const match of text.matchAll(CODE_IDENTIFIER_REGEX)) {
    const raw = match[0];
    for (const variant of expandSymbolToken(raw)) {
      tokens.add(variant);
    }
  }

  return Array.from(tokens);
}

export function buildChunkFtsDoc(input: ChunkFtsDocInput): ChunkFtsDoc {
  const comments: string[] = [];

  let body = input.displayCode;
  body = body.replace(BLOCK_COMMENT_REGEX, (comment) => {
    comments.push(comment);
    return '\n';
  });
  body = body.replace(LINE_COMMENT_REGEX, (comment) => {
    comments.push(comment);
    return '';
  });

  // Python/Ruby/Shell 等常见 # 注释（避免误伤 URL，要求 # 前面是空白或行首）
  body = body.replace(HASH_COMMENT_REGEX, (_full, prefix: string) => {
    const comment = _full.slice(prefix.length);
    comments.push(comment);
    return prefix;
  });

  const normalizedBody = body.trim() || input.displayCode.trim();
  const symbolTokens = collectSymbolTokens(`${input.breadcrumb}\n${input.displayCode}`).join(' ');

  return {
    chunkId: input.chunkId,
    filePath: input.filePath,
    chunkIndex: input.chunkIndex,
    symbolTokens,
    breadcrumb: input.breadcrumb,
    body: normalizedBody,
    comments: comments.join('\n').trim(),
  };
}

// ===========================================
// Indexer 类
// ===========================================

export class Indexer {
  private projectId: string;
  private vectorStore: VectorStoreInstance | null = null;
  private embeddingClient: EmbeddingClient | null = null;
  private vectorDim: number;

  constructor(projectId: string, vectorDim = 1024) {
    this.projectId = projectId;
    this.vectorDim = vectorDim;
  }

  /**
   * 初始化
   */
  async init(): Promise<void> {
    this.vectorStore = await getVectorStore(this.projectId, this.vectorDim);
  }

  /**
   * Embedding 客户端改为惰性初始化。
   *
   * 这样无 chunk 文件的收敛路径不会因为没有真实 embedding 配置而提前失败。
   */
  private getOrCreateEmbeddingClient(): EmbeddingClient {
    if (!this.embeddingClient) {
      this.embeddingClient = getEmbeddingClient();
    }
    return this.embeddingClient;
  }

  /**
   * 清空索引器内部缓存的 EmbeddingClient。
   *
   * Indexer 会在单轮任务内复用 client 以避免重复构造；
   * 但在新的 scan 轮次开始前，必须允许外部刷新配置快照。
   */
  resetEmbeddingClient(): void {
    this.embeddingClient = null;
  }

  /**
   * 处理扫描结果，更新向量索引
   *
   * @param db SQLite 数据库实例
   * @param results 文件处理结果
   * @param onProgress 可选的进度回调 (indexed, total) => void
   */
  async indexFiles(
    db: Database.Database,
    results: ProcessResult[],
    onProgress?: (indexed: number, total: number) => void,
  ): Promise<IndexStats> {
    if (!this.vectorStore) {
      await this.init();
    }

    const stats: IndexStats = {
      indexed: 0,
      deleted: 0,
      errors: 0,
      skipped: 0,
    };

    // 分类处理结果
    const toIndex: FileToIndex[] = [];
    const toDelete: string[] = [];
    const noChunkSettled: Array<{ path: string; hash: string }> = [];

    for (const result of results) {
      switch (result.status) {
        case 'added':
        case 'modified':
          if (result.chunks.length > 0) {
            toIndex.push({
              path: result.relPath,
              hash: result.hash,
              chunks: result.chunks,
            });
          } else {
            // chunks 为空（解析失败或空文件）
            // 仅 modified 文件可能有旧向量记录需要清除，added 文件从未存在过向量记录
            if (result.status === 'modified') {
              toDelete.push(result.relPath);
            }
            noChunkSettled.push({
              path: result.relPath,
              hash: result.hash,
            });
            stats.skipped++;
          }
          break;

        case 'deleted':
          toDelete.push(result.relPath);
          break;

        case 'unchanged':
          stats.skipped++;
          break;

        case 'skipped':
        case 'error':
          stats.skipped++;
          break;
      }
    }

    // 处理删除
    if (toDelete.length > 0) {
      await this.deleteFiles(db, toDelete);
      stats.deleted = toDelete.length;
    }

    // chunks 为空的文件视为已收敛：标记 vector_index_hash=hash
    // 避免这些文件在下一轮被持续判定为“需要自愈”
    if (noChunkSettled.length > 0) {
      batchUpdateVectorIndexHash(db, noChunkSettled);
      logger.debug({ count: noChunkSettled.length }, '无可索引 chunk，标记向量索引状态为已收敛');
    }

    // 批量处理需要索引的文件
    if (toIndex.length > 0) {
      const indexResult = await this.batchIndex(db, toIndex, onProgress);
      stats.indexed = indexResult.success;
      stats.errors = indexResult.errors;
    }

    logger.info(
      {
        indexed: stats.indexed,
        vectorRecordsDeleted: stats.deleted,
        errors: stats.errors,
        skipped: stats.skipped,
      },
      '向量索引完成',
    );

    return stats;
  }

  /**
   * 批量索引文件（断点续传版）
   *
   * 每 BATCH_CHUNKS 个 chunk 为一批，逐批独立完成:
   * 收集 → Embedding → 写库 → 标记 hash。
   * 单批失败不影响其他批次。
   */
  private async batchIndex(
    db: Database.Database,
    files: FileToIndex[],
    onProgress?: (indexed: number, total: number) => void,
  ): Promise<{ success: number; errors: number }> {
    if (files.length === 0) {
      return { success: 0, errors: 0 };
    }

    const batches = splitIntoChunkBatches(files, BATCH_CHUNKS);
    const totalEmbeddingRequests = batches.reduce((sum, batch) => {
      const chunks = batch.reduce((count, file) => count + file.chunks.length, 0);
      return sum + Math.ceil(chunks / 20);
    }, 0);
    let completedEmbeddingRequests = 0;
    let totalSuccess = 0;
    let totalErrors = 0;

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];

      // ===== 阶段 1: 收集本批 texts + 文件范围映射 =====
      const batchTexts: string[] = [];
      const fileRanges: Array<{ fileIdx: number; start: number; end: number }> = [];

      for (let fi = 0; fi < batch.length; fi++) {
        const file = batch[fi];
        const start = batchTexts.length;
        for (const chunk of file.chunks) {
          batchTexts.push(chunk.vectorText);
        }
        fileRanges.push({ fileIdx: fi, start, end: batchTexts.length });
      }

      if (batchTexts.length === 0) {
        continue;
      }

      // ===== 阶段 2: Embedding =====
      const batchEmbeddingRequests = Math.ceil(batchTexts.length / 20);
      let embeddings: number[][];
      try {
        const client = this.getOrCreateEmbeddingClient();
        const results = await client.embedBatch(batchTexts, 20, (completed, _total) => {
          // 每个 chunk batch 都会新建 ProgressTracker，这里统一折算为全局进度。
          onProgress?.(completedEmbeddingRequests + completed, totalEmbeddingRequests);
        });
        completedEmbeddingRequests += batchEmbeddingRequests;
        embeddings = results.map((r) => r.embedding);
      } catch (err) {
        const error = err as { message?: string; stack?: string };
        logger.error({ error: error.message, stack: error.stack }, 'Embedding 失败');
        completedEmbeddingRequests += batchEmbeddingRequests;
        clearVectorIndexHash(
          db,
          batch.map((f) => f.path),
        );
        totalErrors += batch.length;
        continue;
      }

      // ===== 阶段 3: 先组装当前 outer batch 的所有文件记录 =====
      const store = this.vectorStore;
      if (!store) {
        throw new Error('vectorStore 未初始化');
      }

      const filesToWrite: Array<{
        path: string;
        hash: string;
        records: ChunkRecord[];
        ftsDocs: ChunkFtsDoc[];
      }> = [];
      const errorFiles: string[] = [];

      for (let fi = 0; fi < batch.length; fi++) {
        const file = batch[fi];
        const range = fileRanges[fi];
        if (!range) {
          errorFiles.push(file.path);
          continue;
        }

        const records: ChunkRecord[] = [];
        const fileFtsChunks: ChunkFtsDoc[] = [];

        for (let ci = 0; ci < file.chunks.length; ci++) {
          const chunk = file.chunks[ci];
          const embedding = embeddings[range.start + ci];

          const record: ChunkRecord = {
            chunk_id: `${file.path}#${file.hash}#${ci}`,
            file_path: file.path,
            file_hash: file.hash,
            chunk_index: ci,
            vector: embedding,
            display_code: chunk.displayCode,
            vector_text: chunk.vectorText,
            language: chunk.metadata.language,
            breadcrumb: chunk.metadata.contextPath.join(' > '),
            start_index: chunk.metadata.startIndex,
            end_index: chunk.metadata.endIndex,
            raw_start: chunk.metadata.rawSpan.start,
            raw_end: chunk.metadata.rawSpan.end,
            vec_start: chunk.metadata.vectorSpan.start,
            vec_end: chunk.metadata.vectorSpan.end,
          };

          records.push(record);
          fileFtsChunks.push(
            buildChunkFtsDoc({
              chunkId: record.chunk_id,
              filePath: record.file_path,
              chunkIndex: record.chunk_index,
              breadcrumb: record.breadcrumb,
              displayCode: record.display_code,
            }),
          );
        }

        filesToWrite.push({
          path: file.path,
          hash: file.hash,
          records,
          ftsDocs: fileFtsChunks,
        });
      }

      // ===== 阶段 4-6: 按 VectorStore 子批次写入并即时确认 =====
      // 这里故意不把确认拖到整个 outer batch 末尾：
      // 某个子批次成功后立即更新 FTS + vector_index_hash，
      // 中断时最多只会重做最后未确认的子批次。
      const upsertBatches = VectorStore.splitUpsertBatches(filesToWrite);

      for (const upsertBatch of upsertBatches) {
        try {
          await store.batchUpsertFiles(
            upsertBatch.map(({ path, hash, records }) => ({ path, hash, records })),
          );
        } catch (err) {
          const error = err as { message?: string; stack?: string };
          logger.error(
            {
              paths: upsertBatch.map((file) => file.path),
              error: error.message,
              stack: error.stack,
            },
            '批量写入 LanceDB 失败',
          );
          // 子批次失败时保留旧向量版本，后续由 healing 重新补齐。
          errorFiles.push(...upsertBatch.map((file) => file.path));
          continue;
        }

        const successFiles = upsertBatch.map(({ path, hash }) => ({ path, hash }));
        const successFtsChunks = upsertBatch.flatMap((file) => file.ftsDocs);

        if (successFiles.length > 0 && isChunksFtsInitialized(db)) {
          try {
            const pathsToDelete = successFiles.map((file) => file.path);
            batchDeleteFileChunksFts(db, pathsToDelete);
            batchUpsertChunkFts(db, successFtsChunks);
          } catch (err) {
            const error = err as { message?: string };
            logger.warn({ error: error.message }, 'FTS 批量更新失败（向量索引已成功）');
          }
        }

        if (successFiles.length > 0) {
          batchUpdateVectorIndexHash(db, successFiles);
        }

        totalSuccess += successFiles.length;
      }

      totalErrors += errorFiles.length;
    }

    logger.info({ success: totalSuccess, errors: totalErrors }, '批量索引完成');

    return { success: totalSuccess, errors: totalErrors };
  }

  /**
   * 删除文件的向量和 FTS 索引
   */
  private async deleteFiles(db: Database.Database, paths: string[]): Promise<void> {
    if (!this.vectorStore) return;

    // 删除向量索引
    await this.vectorStore.deleteFiles(paths);

    // 删除 chunk FTS 索引
    if (isChunksFtsInitialized(db)) {
      batchDeleteFileChunksFts(db, paths);
    }

    logger.debug({ count: paths.length }, '删除文件索引');
  }

  /**
   * 向量搜索
   */
  async search(queryVector: number[], limit = 10, filter?: string) {
    if (!this.vectorStore) {
      await this.init();
    }
    return this.vectorStore?.search(queryVector, limit, filter);
  }

  /**
   * 文本搜索（先 embedding 再向量搜索）
   */
  async textSearch(query: string, limit = 10, filter?: string) {
    const queryVector = await this.getOrCreateEmbeddingClient().embed(query);
    return this.search(queryVector, limit, filter);
  }

  /**
   * 清空索引
   */
  async clear(): Promise<void> {
    if (!this.vectorStore) {
      await this.init();
    }
    await this.vectorStore?.clear();
  }

  /**
   * 获取索引统计
   */
  async getStats(): Promise<{ totalChunks: number }> {
    if (!this.vectorStore) {
      await this.init();
    }
    const count = (await this.vectorStore?.count()) ?? 0;
    return { totalChunks: count };
  }
}

// ===========================================
// 工厂函数
// ===========================================

const indexers = new Map<string, Indexer>();

/**
 * 获取或创建 Indexer 实例
 */
export async function getIndexer(projectId: string, vectorDim = 1024): Promise<Indexer> {
  let indexer = indexers.get(projectId);
  if (!indexer) {
    indexer = new Indexer(projectId, vectorDim);
    await indexer.init();
    indexers.set(projectId, indexer);
  }
  return indexer;
}

/**
 * 释放单个项目的 Indexer 缓存。
 *
 * Indexer 当前不持有显式 close 的 native 句柄，但检索路径会按项目创建实例；
 * 主动删除缓存可避免长时间运行的 MCP 进程按项目无限增长。
 */
export function closeIndexer(projectId: string): void {
  indexers.delete(projectId);
}

/**
 * 关闭所有 Indexer
 */
export function closeAllIndexers(): void {
  indexers.clear();
}
