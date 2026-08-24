/**
 * Line Breaks for AI
 *
 * A minimal, non-destructive utility that adds line breaks to HTML content
 * so AI can reliably use line-based editing via replace_lines.
 *
 * IMPORTANT: This function ONLY adds newlines. It does NOT:
 * - Remove trailing spaces (preserves user's mid-thought content)
 * - Remove existing newlines (a blank line between two blocks survives)
 * - Reformat or restructure content
 * - Change any existing characters
 *
 * That "only adds" property is what makes the function idempotent, and
 * idempotence is what lets the write paths STORE this normalized form: the
 * count a write reports is then exactly the count the next read returns.
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
  'caption',
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
  'dl',
  'dt',
  'dd',
  'address',
  'details',
  'summary',
  'hgroup',
];

/**
 * Void elements that terminate a line of rendered text. `<br>` is the reason
 * this list exists: a document laid out entirely with `<br>` separators (what
 * pasting markdown into the editor produces) contains no block tag at all, so
 * before #2463 it normalized to zero newlines and reported `totalLines: 1` for
 * an eighteen-line document. Line numbers an agent cannot trust are worse than
 * no line numbers, because it edits against them anyway.
 */
const LINE_BREAK_TAGS = ['br'];

/** Void elements that are blocks in their own right — a newline on both sides. */
const BLOCK_VOID_TAGS = ['hr'];

/**
 * Attribute run for a tag: bare, or whitespace followed by attributes whose
 * quoted values may themselves contain `>`.
 */
const TAG_ATTRIBUTES = `(?:\\s+(?:[^"'<>]|"[^"]*"|'[^']*')*)?\\s*`;

const blockTagPattern = BLOCK_TAGS.join('|');
const blockOpeningTagPattern = `<(?:${blockTagPattern})${TAG_ATTRIBUTES}>`;

/** Matches `<br>`, `<br/>`, `<br />` and the attributed forms of each. */
function voidTagPattern(tags: string[]): string {
  return `<(?:${tags.join('|')})${TAG_ATTRIBUTES}/?\\s*>`;
}

const lineBreakTagPattern = voidTagPattern([...LINE_BREAK_TAGS, ...BLOCK_VOID_TAGS]);
const blockVoidTagPattern = voidTagPattern(BLOCK_VOID_TAGS);

const STRUCTURAL_MARKUP_REGEX = new RegExp(
  `(?:${blockOpeningTagPattern})|(?:</(?:${blockTagPattern})>)|(?:${lineBreakTagPattern})`,
  'i'
);

/**
 * True when `html` contains markup that {@link addLineBreaksForAI} gives line
 * structure to — a block element or a `<br>`/`<hr>`.
 *
 * This is the honest test for "is this an HTML document?", as opposed to the
 * `<[a-z]...>` sniff below which a raw JSON blob containing `"<a>"` passes.
 * Content that fails it has no HTML line structure, so its lines are simply
 * its own newlines: that is what an html-mode page holding JSON or markdown
 * (#2463) actually is, and callers use this to say so out loud.
 */
export function hasLineStructuringHtml(html: string | null | undefined): boolean {
  if (!html) return false;
  return STRUCTURAL_MARKUP_REGEX.test(html);
}

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
  // Match: </tag><tag> or </tag> <tag> (with optional horizontal whitespace).
  // Two details, both in service of the "only adds" contract this file's
  // header promises — and with it the idempotence the write paths rely on:
  // `\s*` here would have SWALLOWED a newline, collapsing a deliberate blank
  // line between two blocks, and the separating spaces were dropped rather
  // than carried through to the replacement.
  const adjacentTagRegex = new RegExp(
    `(</(?:${blockTagPattern})>)([^\\S\\n]*)(${blockOpeningTagPattern})`,
    'gi'
  );
  result = result.replace(adjacentTagRegex, '$1$2\n$3');

  // Add newline before <hr> — it is a block, so it owns its own line.
  const blockVoidRegex = new RegExp(`(?<!\\n)(${blockVoidTagPattern})`, 'gi');
  result = result.replace(blockVoidRegex, '\n$1');

  // Add newline after <br>/<hr>. Runs LAST so that a `<br>` already followed
  // by a newline inserted by the closing-tag pass (`a<br></p>`) is left alone
  // rather than gaining a second, empty line.
  const lineBreakRegex = new RegExp(`(${lineBreakTagPattern})(?!\\n)`, 'gi');
  result = result.replace(lineBreakRegex, '$1\n');

  return result;
}
