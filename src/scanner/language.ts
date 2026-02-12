/**
 * 文件扩展名到语言标识的映射
 */
const LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.md': 'markdown',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.cs': 'c_sharp',
  '.csx': 'c_sharp',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.h': 'cpp',
  '.c': 'c',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.fish': 'shell',
  '.ps1': 'powershell',
  '.sql': 'sql',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.json': 'json',
  '.toml': 'toml',
  '.xml': 'xml',
  '.html': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'sass',
  '.less': 'less',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.rb': 'ruby',
  '.php': 'php',
  '.dart': 'dart',
  '.lua': 'lua',
  '.r': 'r',
};

/**
 * 允许的文件扩展名白名单
 */
const ALLOWED_EXTENSIONS = new Set(Object.keys(LANGUAGE_MAP));

/**
 * 白名单扩展名对应的语言集合
 */
const ALLOWED_LANGUAGES = new Set(Object.values(LANGUAGE_MAP));

/**
 * 根据文件路径获取语言标识
 * @param filePath 文件路径
 * @returns 语言标识，如果不在白名单中则返回 unknown
 */
export function getLanguage(filePath: string): string {
  const ext = getFileExtension(filePath);
  return LANGUAGE_MAP[ext] || 'unknown';
}

/**
 * 判断文件是否在允许的扩展名白名单中
 * @param filePath 文件路径
 * @returns 是否允许
 */
export function isAllowedExtension(filePath: string): boolean {
  const ext = getFileExtension(filePath);
  return ALLOWED_EXTENSIONS.has(ext);
}

/**
 * 语言分类常量
 */
export const LANGUAGE_CATEGORIES = {
  code: [
    'typescript',
    'javascript',
    'python',
    'go',
    'rust',
    'java',
    'kotlin',
    'swift',
    'c_sharp',
    'cpp',
    'c',
    'ruby',
    'php',
    'dart',
    'lua',
    'r',
    'shell',
    'powershell',
    'sql',
    'html',
    'css',
    'scss',
    'sass',
    'less',
    'vue',
    'svelte',
  ],
  docs: ['markdown'],
  config: ['json', 'yaml', 'toml', 'xml'],
} as const;

/**
 * 获取白名单扩展名对应的语言列表
 * @returns 语言标识数组
 */
export function getAllowedLanguages(): string[] {
  return [...ALLOWED_LANGUAGES];
}

/**
 * 获取代码类语言列表（排除文档和配置类语言）
 * @returns 代码类语言标识数组
 */
export function getCodeLanguages(): string[] {
  return [...LANGUAGE_CATEGORIES.code];
}

/**
 * 判断语言是否在白名单中
 * @param lang 语言标识
 * @returns 是否为已知语言
 */
export function isKnownLanguage(lang: string): boolean {
  return ALLOWED_LANGUAGES.has(lang);
}

/**
 * 获取文件扩展名（包含点）
 * @param filePath 文件路径
 * @returns 扩展名，如 ".ts"
 */
function getFileExtension(filePath: string): string {
  const ext = filePath.split('.').pop();
  return ext ? `.${ext.toLowerCase()}` : '';
}
