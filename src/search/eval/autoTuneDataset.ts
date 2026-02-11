import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AutoTuneCase } from './types.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ensureString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`字段 ${field} 必须是非空字符串`);
  }
  return value;
}

function ensureStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`字段 ${field} 必须是字符串数组`);
  }

  const output: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new Error(`字段 ${field} 必须只包含非空字符串`);
    }
    output.push(item);
  }

  return output;
}

function ensureRelevanceMap(value: unknown, field: string): Record<string, number> {
  if (!isPlainObject(value)) {
    throw new Error(`字段 ${field} 必须是对象`);
  }

  const output: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
      throw new Error(`字段 ${field}.${key} 必须是非负数字`);
    }
    output[key] = raw;
  }

  return output;
}

function parseJsonl(content: string): unknown[] {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.map((line, lineIndex) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`JSONL 解析失败（第 ${lineIndex + 1} 行）：${(error as Error).message}`);
    }
  });
}

function parseJson(content: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`JSON 解析失败：${(error as Error).message}`);
  }

  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (isPlainObject(parsed) && Array.isArray(parsed.cases)) {
    return parsed.cases;
  }

  throw new Error('JSON 文件应为数组，或包含 cases 数组字段');
}

function normalizeCase(raw: unknown, index: number): AutoTuneCase {
  if (!isPlainObject(raw)) {
    throw new Error(`第 ${index + 1} 条样本必须是对象`);
  }

  return {
    id: ensureString(raw.id, `id (line ${index + 1})`),
    query: ensureString(raw.query, `query (line ${index + 1})`),
    vectorRetrieved: ensureStringArray(
      raw.vectorRetrieved,
      `vectorRetrieved (line ${index + 1})`,
    ),
    lexicalRetrieved: ensureStringArray(
      raw.lexicalRetrieved,
      `lexicalRetrieved (line ${index + 1})`,
    ),
    relevant: ensureRelevanceMap(raw.relevant, `relevant (line ${index + 1})`),
  };
}

export async function loadAutoTuneDataset(datasetPath: string): Promise<AutoTuneCase[]> {
  const absolutePath = path.resolve(datasetPath);
  const content = await fs.readFile(absolutePath, 'utf-8');
  const ext = path.extname(absolutePath).toLowerCase();

  const rawEntries = ext === '.jsonl' ? parseJsonl(content) : parseJson(content);
  return rawEntries.map((entry, index) => normalizeCase(entry, index));
}
