import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { batchUpsert, closeDb, initDb, type FileMeta } from '../../src/db/index.js';
import { ContextPacker } from '../../src/search/ContextPacker.js';
import { DEFAULT_CONFIG } from '../../src/search/config.js';
import type { ScoredChunk } from '../../src/search/types.js';

function projectDir(projectId: string): string {
  return path.join(os.homedir(), '.contextweaver', projectId);
}

function buildChunk(args: {
  filePath: string;
  chunkIndex: number;
  score: number;
  rawStart: number;
  rawEnd: number;
}): ScoredChunk {
  const fileHash = 'h';
  return {
    filePath: args.filePath,
    chunkIndex: args.chunkIndex,
    score: args.score,
    source: 'vector',
    record: {
      chunk_id: `${args.filePath}#${fileHash}#${args.chunkIndex}`,
      file_path: args.filePath,
      file_hash: fileHash,
      chunk_index: args.chunkIndex,
      vector: [0],
      display_code: '',
      vector_text: '',
      language: 'typescript',
      breadcrumb: `${args.filePath} > fn`,
      start_index: args.rawStart,
      end_index: args.rawEnd,
      raw_start: args.rawStart,
      raw_end: args.rawEnd,
      vec_start: args.rawStart,
      vec_end: args.rawEnd,
      _distance: 0,
    },
  };
}

test('同文件重叠区间应合并为单段', async () => {
  const projectId = `packer-merge-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const db = initDb(projectId);

  try {
    const filePath = 'src/a.ts';
    const content = 'line1\nline2\nline3\nline4\n';

    const files: FileMeta[] = [
      {
        path: filePath,
        hash: 'hash-a',
        mtime: Date.now(),
        size: content.length,
        content,
        language: 'typescript',
        vectorIndexHash: null,
      },
    ];
    batchUpsert(db, files);

    const packer = new ContextPacker(projectId, {
      ...DEFAULT_CONFIG,
      maxSegmentsPerFile: 3,
      maxTotalChars: 1000,
    });

    const packed = await packer.pack([
      buildChunk({ filePath, chunkIndex: 0, score: 0.9, rawStart: 0, rawEnd: 11 }),
      buildChunk({ filePath, chunkIndex: 1, score: 0.7, rawStart: 8, rawEnd: 18 }),
    ]);

    assert.equal(packed.length, 1);
    assert.equal(packed[0].segments.length, 1);
    assert.equal(packed[0].segments[0].rawStart, 0);
    assert.equal(packed[0].segments[0].rawEnd, 18);
  } finally {
    closeDb(db);
    await fs.rm(projectDir(projectId), { recursive: true, force: true });
  }
});

test('maxSegmentsPerFile 与 maxTotalChars 应生效', async () => {
  const projectId = `packer-budget-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const db = initDb(projectId);

  try {
    const fileA = 'src/a.ts';
    const fileB = 'src/b.ts';
    const contentA = 'aaaaaaaaaa\nbbbbbbbbbb\ncccccccccc\n';
    const contentB = 'xxxxxxxxxx\nyyyyyyyyyy\nzzzzzzzzzz\n';

    const files: FileMeta[] = [
      {
        path: fileA,
        hash: 'hash-a',
        mtime: Date.now(),
        size: contentA.length,
        content: contentA,
        language: 'typescript',
        vectorIndexHash: null,
      },
      {
        path: fileB,
        hash: 'hash-b',
        mtime: Date.now(),
        size: contentB.length,
        content: contentB,
        language: 'typescript',
        vectorIndexHash: null,
      },
    ];
    batchUpsert(db, files);

    const packer = new ContextPacker(projectId, {
      ...DEFAULT_CONFIG,
      maxSegmentsPerFile: 1,
      maxTotalChars: 19,
    });

    const packed = await packer.pack([
      buildChunk({ filePath: fileA, chunkIndex: 0, score: 0.95, rawStart: 0, rawEnd: 10 }),
      buildChunk({ filePath: fileA, chunkIndex: 1, score: 0.8, rawStart: 11, rawEnd: 21 }),
      buildChunk({ filePath: fileB, chunkIndex: 0, score: 0.7, rawStart: 0, rawEnd: 10 }),
    ]);

    assert.equal(packed.length, 1, '预算限制下应仅保留一个文件');
    assert.equal(packed[0].filePath, fileA);
    assert.equal(packed[0].segments.length, 1, '每文件最多 1 段');
  } finally {
    closeDb(db);
    await fs.rm(projectDir(projectId), { recursive: true, force: true });
  }
});
