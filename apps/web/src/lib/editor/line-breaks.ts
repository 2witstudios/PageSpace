/**
 * Line Breaks for AI
 *
 * A minimal, non-destructive utility that adds line breaks to HTML content
 * so AI can reliably use line-based editing via replace_lines.
 *
 * IMPORTANT: This function ONLY adds newlines. It does NOT:
 * - Remove trailing spaces (preserves user's mid-thought content)
 * - Reformat or restructure content
 * - Change any existing characters
 *
 * This replaces Prettier for AI tool usage, avoiding the data loss
 * issues caused by Prettier's whitespace normalization.
 */

// Block-level HTML tags that should have newlines around them
const BLOCK_TAGS = [
  'p',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'table',
  'tr',
  'td',
  'th',
  'thead',
  'tbody',
  'blockquote',
  'pre',
  'section',
  'article',
  'header',
  'footer',
  'nav',
  'aside',
  'main',
  'figure',
  'figcaption',
];

/**
 * Adds line breaks between block-level HTML tags for AI line-based editing.
 *
 * @param html - The HTML string to process
 * @returns HTML with newlines added after opening block tags and before closing block tags
 *
 * @example
 * // Input: '<p>Hello World </p>'
 * // Output: '<p>\nHello World \n</p>'
 *
 * // Input: '<p>First</p><p>Second</p>'
 * // Output: '<p>\nFirst\n</p>\n<p>\nSecond\n</p>'
 */
export function addLineBreaksForAI(html: string): string {
  // Handle null/undefined gracefully
  if (html == null) return html;

  // Handle empty string
  if (html === '') return '';

  // Handle plain text (no HTML tags)
  if (!/<[a-z][\s\S]*>/i.test(html)) {
    return html;
  }

  let result = html;

  // Create regex pattern for block tags
  const blockTagPattern = BLOCK_TAGS.join('|');
  const blockOpeningTagPattern = `<(?:${blockTagPattern})(?:\\s+(?:[^"'<>]|"[^"]*"|'[^']*')*)?\\s*>`;

  // Add newline after opening block tags (if not already present)
  // Match: <tag> or <tag attr="value"> but not if followed by newline
  const openingTagRegex = new RegExp(
    `(${blockOpeningTagPattern})(?!\\n)`,
    'gi'
  );
  result = result.replace(openingTagRegex, '$1\n');

  // Add newline before closing block tags (if not already present)
  // Match: </tag> but not if preceded by newline
  const closingTagRegex = new RegExp(
    `(?<!\\n)(</(?:${blockTagPattern})>)`,
    'gi'
  );
  result = result.replace(closingTagRegex, '\n$1');

  // Add newline between adjacent closing and opening block tags
  // Match: </tag><tag> or </tag> <tag> (with optional whitespace)
  const adjacentTagRegex = new RegExp(
    `(</(?:${blockTagPattern})>)\\s*(${blockOpeningTagPattern})`,
    'gi'
  );
  result = result.replace(adjacentTagRegex, '$1\n$2');

  return result;
}
