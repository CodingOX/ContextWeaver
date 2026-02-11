import type { QueryChannels } from './types.js';

export interface BuildQueryChannelsInput {
  informationRequest: string;
  technicalTerms?: string[];
}

/**
 * 构建查询分通道：
 * - 向量通道：仅 information_request
 * - 词法通道：technical_terms 优先，information_request 补充
 * - rerank 通道：完整 query（兼容旧行为）
 */
export function buildQueryChannels(input: BuildQueryChannelsInput): QueryChannels {
  const informationRequest = input.informationRequest.trim();
  const technicalTerms = normalizeTechnicalTerms(input.technicalTerms);

  const lexicalQuery = [technicalTerms.join(' '), informationRequest].filter(Boolean).join(' ').trim();
  const rerankQuery = [informationRequest, ...technicalTerms].filter(Boolean).join(' ').trim();

  return {
    vectorQuery: informationRequest,
    lexicalQuery: lexicalQuery || informationRequest,
    rerankQuery: rerankQuery || informationRequest,
  };
}

function normalizeTechnicalTerms(technicalTerms?: string[]): string[] {
  if (!technicalTerms) return [];

  const seen = new Set<string>();
  const terms: string[] = [];

  for (const term of technicalTerms) {
    const normalized = term.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    terms.push(normalized);
  }

  return terms;
}
