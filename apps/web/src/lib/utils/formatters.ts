export function toTitleCase(str: string): string {
  return str
    .toLowerCase()
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

const LANGUAGE_EXTENSION_MAP: Record<string, string> = {
  'ts': 'typescript',
  'tsx': 'tsx',
  'js': 'javascript',
  'jsx': 'jsx',
  'json': 'json',
  'md': 'markdown',
  'mdx': 'mdx',
  'css': 'css',
  'scss': 'scss',
  'html': 'html',
  'xml': 'xml',
  'yaml': 'yaml',
  'yml': 'yaml',
  'py': 'python',
  'rb': 'ruby',
  'go': 'go',
  'rs': 'rust',
  'sql': 'sql',
  'sh': 'bash',
  'bash': 'bash',
  'zsh': 'bash',
  'txt': 'text',
};

/**
 * Infer the programming language from a file path based on extension.
 * Returns a Shiki-compatible language identifier.
 */
export function getLanguageFromPath(path?: string): string {
  if (!path) return 'text';
  const ext = path.split('.').pop()?.toLowerCase();
  return LANGUAGE_EXTENSION_MAP[ext || ''] || 'text';
}