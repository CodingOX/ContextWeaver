/**
 * codebase-retrieval MCP Tool
 *
 * 只负责 MCP 参数适配、调用公共搜索编排服务、以及结果格式化。
 */

import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { ContextPack, Segment } from '../../search/types.js';
import { logger } from '../../utils/logger.js';
import { MissingEnvError, searchCodebase } from '../../app/searchCodebase.js';
import { formatSearchText } from '../../app/formatSearchText.js';
import type { SearchConfig } from '../../search/types.js';

export const codebaseRetrievalSchema = z.object({
  repo_path: z
    .string()
    .describe(
      "The absolute file system path to the repository root. (e.g., '/Users/dev/my-project')",
    ),
  information_request: z
    .string()
    .describe(
      "The SEMANTIC GOAL. Describe the functionality, logic, or behavior you are looking for in full natural language sentences. Focus on 'how it works' rather than exact names. (e.g., 'Trace the execution flow of the login process')",
    ),
  technical_terms: z
    .array(z.string())
    .optional()
    .describe(
      'HARD FILTERS. Precise identifiers to narrow down results. Only use symbols KNOWN to exist to avoid false negatives.',
    ),
});

export type CodebaseRetrievalInput = z.infer<typeof codebaseRetrievalSchema>;

const ZEN_CONFIG_OVERRIDE: Partial<SearchConfig> = {
  neighborHops: 2,
  breadcrumbExpandLimit: 3,
  importFilesPerSeed: 0,
  chunksPerImportFile: 0,
};

export type ProgressCallback = (current: number, total?: number, message?: string) => void;

export async function handleCodebaseRetrieval(
  args: CodebaseRetrievalInput,
  configOverride: Partial<SearchConfig> = ZEN_CONFIG_OVERRIDE,
  onProgress?: ProgressCallback,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { repo_path, information_request, technical_terms } = args;

  logger.info(
    {
      repo_path,
      information_request,
      technical_terms,
    },
    'MCP codebase-retrieval 调用开始',
  );

  const query = [information_request, ...(technical_terms || [])].filter(Boolean).join(' ');

  try {
    const result = await searchCodebase({
      repoPath: repo_path,
      query,
      configOverride,
      onProgress,
    });

    logger.info(
      {
        projectId: result.projectId.slice(0, 10),
        query: result.query,
        zenConfig: configOverride,
      },
      'MCP 查询构建',
    );

    return formatMcpResponse(result.contextPack);
  } catch (error) {
    if (error instanceof MissingEnvError) {
      logger.warn(
        {
          missingVars: error.missingVars,
        },
        'MCP 环境变量未配置',
      );
      return formatEnvMissingResponse(error.missingVars);
    }

    throw error;
  }
}

export function formatMcpResponse(
  pack: ContextPack,
): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [
      {
        type: 'text',
        text: formatSearchText(pack),
      },
    ],
  };
}

export function formatEnvMissingResponse(missingVars: string[]): {
  content: Array<{ type: 'text'; text: string }>;
} {
  const configPath = path.join(os.homedir(), '.contextweaver', '.env');

  const text = `## ⚠️ 配置缺失

ContextWeaver 需要配置 Embedding API 才能工作。

### 缺失的环境变量
${missingVars.map((v) => `- \`${v}\``).join('\n')}

### 配置步骤

已自动创建配置文件：\`${configPath}\`

请编辑该文件，填写你的 API Key：

\`\`\`bash
# Embedding API 配置（必需）
EMBEDDINGS_API_KEY=your-api-key-here  # ← 替换为你的 API Key

# Reranker 配置（必需）
RERANK_API_KEY=your-api-key-here      # ← 替换为你的 API Key
\`\`\`

保存文件后重新调用此工具即可。
`;

  return {
    content: [
      {
        type: 'text',
        text,
      },
    ],
  };
}
