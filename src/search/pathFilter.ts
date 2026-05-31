import path from 'node:path';

export interface FilePathFilterConfig {
  includeGlobs: string[];
  excludeGlobs: string[];
}

function normalizeGlobList(globs?: string[]): string[] {
  if (!Array.isArray(globs)) return [];

  return globs
    .map((glob) => glob.trim())
    .filter(Boolean)
    .map((glob) => glob.replace(/\\/g, '/'));
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegex(glob: string): RegExp {
  let pattern = '';

  for (let i = 0; i < glob.length; i++) {
    const current = glob[i];
    const next = glob[i + 1];

    if (current === '*') {
      if (next === '*') {
        pattern += '.*';
        i++;
      } else {
        pattern += '[^/]*';
      }
      continue;
    }

    if (current === '?') {
      pattern += '[^/]';
      continue;
    }

    pattern += escapeRegex(current);
  }

  return new RegExp(`^${pattern}$`);
}

function normalizeFilePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

export function normalizeFilePathFilterConfig(input?: {
  includeGlobs?: string[];
  excludeGlobs?: string[];
}): FilePathFilterConfig {
  return {
    includeGlobs: normalizeGlobList(input?.includeGlobs),
    excludeGlobs: normalizeGlobList(input?.excludeGlobs),
  };
}

export function createFilePathFilter(config: FilePathFilterConfig): (filePath: string) => boolean {
  const includeRegexes = config.includeGlobs.map(globToRegex);
  const excludeRegexes = config.excludeGlobs.map(globToRegex);

  return (filePath: string): boolean => {
    const normalizedPath = normalizeFilePath(path.posix.normalize(filePath));

    const included =
      includeRegexes.length === 0 || includeRegexes.some((regex) => regex.test(normalizedPath));
    if (!included) return false;

    return !excludeRegexes.some((regex) => regex.test(normalizedPath));
  };
}
