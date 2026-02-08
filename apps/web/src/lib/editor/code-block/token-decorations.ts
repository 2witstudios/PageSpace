import type { ThemedToken, FontStyle } from 'shiki';
import { Decoration } from '@tiptap/pm/view';

export interface DecorationSpec {
  from: number;
  to: number;
  style: string;
}

function fontStyleToCss(fontStyle: FontStyle | undefined): string {
  if (!fontStyle) return '';
  const parts: string[] = [];
  // FontStyle bit flags: 1=italic, 2=bold, 4=underline
  if (fontStyle & 1) parts.push('font-style: italic');
  if (fontStyle & 2) parts.push('font-weight: bold');
  if (fontStyle & 4) parts.push('text-decoration: underline');
  return parts.join('; ');
}

/**
 * Convert Shiki themed tokens into ProseMirror Decoration.inline specs.
 * `blockStart` is the absolute position of the first character of the code
 * block's text content in the ProseMirror document.
 */
export function tokensToDecorationSpecs(
  tokens: ThemedToken[][],
  blockStart: number
): DecorationSpec[] {
  const specs: DecorationSpec[] = [];
  let offset = blockStart;

  for (let lineIdx = 0; lineIdx < tokens.length; lineIdx++) {
    if (lineIdx > 0) offset += 1; // account for \n between lines

    const line = tokens[lineIdx];
    for (const token of line) {
      const content = token.content;
      const len = content.length;

      if (content.trim() === '' || !token.color) {
        offset += len;
        continue;
      }

      const styleParts: string[] = [`color: ${token.color}`];
      const fontCss = fontStyleToCss(token.fontStyle);
      if (fontCss) styleParts.push(fontCss);

      specs.push({
        from: offset,
        to: offset + len,
        style: styleParts.join('; '),
      });

      offset += len;
    }
  }

  return specs;
}

export function specsToDecorations(specs: DecorationSpec[]): Decoration[] {
  return specs.map((s) =>
    Decoration.inline(s.from, s.to, { style: s.style })
  );
}
