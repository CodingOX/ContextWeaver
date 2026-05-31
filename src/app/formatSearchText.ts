import type { ContextPack, Segment } from '../search/types.js';

/**
 * 将 ContextPack 统一格式化成文本。
 *
 * CLI 和 MCP 都必须走这条路径，保证同一份上下文包输出完全一致。
 */
export function formatSearchText(pack: ContextPack): string {
  const { files, seeds } = pack;

  const fileBlocks = files
    .map((file) => {
      return file.segments.map((segment) => formatSegment(segment)).join('\n\n');
    })
    .join('\n\n---\n\n');

  const summary = [
    `Found ${seeds.length} relevant code blocks`,
    `Files: ${files.length}`,
    `Total segments: ${files.reduce((acc, file) => acc + file.segments.length, 0)}`,
  ].join(' | ');

  return fileBlocks ? `${summary}\n\n${fileBlocks}` : summary;
}

function formatSegment(segment: Segment): string {
  const lang = detectLanguage(segment.filePath);
  const header = `## ${segment.filePath} (L${segment.startLine}-${segment.endLine})`;
  const breadcrumb = segment.breadcrumb ? `> ${segment.breadcrumb}` : '';
  const code = `\`\`\`${lang}\n${segment.text}\n\`\`\``;

  return [header, breadcrumb, code].filter(Boolean).join('\n');
}

function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    rb: 'ruby',
    php: 'php',
    swift: 'swift',
    kt: 'kotlin',
    scala: 'scala',
    sql: 'sql',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    md: 'markdown',
    toml: 'toml',
  };

  return langMap[ext] || ext || 'plaintext';
}
