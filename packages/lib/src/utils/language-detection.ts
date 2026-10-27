/**
 * Language Detection Utility
 *
 * Maps file extensions to programming language identifiers.
 * Used by CODE page views and GitHub import tools.
 */

export const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  'js': 'javascript',
  'jsx': 'javascript',
  'ts': 'typescript',
  'tsx': 'typescript',
  'py': 'python',
  'java': 'java',
  'c': 'c',
  'cpp': 'cpp',
  'cs': 'csharp',
  'rb': 'ruby',
  'go': 'go',
  'rs': 'rust',
  'php': 'php',
  'swift': 'swift',
  'kt': 'kotlin',
  'html': 'html',
  'css': 'css',
  'scss': 'scss',
  'json': 'json',
  'xml': 'xml',
  'yaml': 'yaml',
  'yml': 'yaml',
  'md': 'markdown',
  'sh': 'shell',
  'bash': 'shell',
  'zsh': 'shell',
  'sql': 'sql',
  'graphql': 'graphql',
  'gql': 'graphql',
  'svg': 'xml',
  'sudo': 'sudolang',
  'sudolang': 'sudolang',
};

/**
 * Detect language from a filename based on its extension.
 * Returns 'plaintext' if the extension is not recognized.
 */
export function detectLanguageFromFilename(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext && ext in EXTENSION_TO_LANGUAGE) {
    return EXTENSION_TO_LANGUAGE[ext];
  }
  return 'plaintext';
}

/** Known binary file extensions that should not be imported as text */
export const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'avif',
  'mp3', 'mp4', 'wav', 'ogg', 'webm', 'avi', 'mov',
  'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar',
  'exe', 'dll', 'so', 'dylib', 'wasm',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
]);

/**
 * Check if a filename refers to a binary file based on its extension.
 */
export function isBinaryFile(filename: string): boolean {
  const ext = filename.toLowerCase().split('.').pop();
  return ext ? BINARY_EXTENSIONS.has(ext) : false;
}
