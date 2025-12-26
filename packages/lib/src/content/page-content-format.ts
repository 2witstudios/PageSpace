export type PageContentFormat = 'text' | 'html' | 'json' | 'tiptap';

export function detectPageContentFormat(content: string): PageContentFormat {
  const trimmed = content.trim();
  if (!trimmed) {
    return 'text';
  }

  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    return 'html';
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && (parsed as { type?: string }).type === 'doc') {
      return 'tiptap';
    }
    return 'json';
  } catch {
    return 'text';
  }
}
