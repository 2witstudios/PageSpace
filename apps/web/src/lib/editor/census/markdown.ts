import { lexer, type Token, type Tokens } from 'marked';

/**
 * Markdown constructs the ProseMirror schema has no node or mark for.
 *
 * `contentMode='markdown'` documents are stored as markdown source, not HTML,
 * so they cannot be round-tripped through the schema the way an HTML document
 * can — there is nothing to diff against until they are migrated onto this
 * surface. This is therefore SOURCE-SYNTAX detection, not a measured loss: it
 * answers "what would Phase K have to carry across", which is the question the
 * census is being asked about them.
 *
 * Tokenized with `marked` — already a direct dependency, and already how this
 * repo reads markdown (convert-content-mode, publish-page, broadcast/content).
 * Hand-rolled regexes would have to re-learn that `![alt](a.png)` inside a
 * fenced block, an indented block or a backtick span is an EXAMPLE of an image
 * rather than an image, which is exactly the content a knowledge base about
 * markdown is full of.
 */
const enum Construct {
  Image = 'md:image',
  TaskList = 'md:task-list',
  DeepHeading = 'md:heading-4-6',
  RawHtml = 'md:raw-html',
  Footnote = 'md:footnote',
  Highlight = 'md:highlight',
  Strikethrough = 'md:strikethrough',
}

/** `==highlight==` is an extension marked's core does not tokenize. */
const HIGHLIGHT = /==[^=\n]+==/;

function childTokens(token: Token): Token[] {
  const children: Token[] = [];
  if ('tokens' in token && token.tokens) children.push(...token.tokens);
  if ('items' in token && token.items) children.push(...(token as Tokens.List).items);
  // Table cells hang off header/rows rather than tokens, so a generic walk
  // misses every image and checkbox inside a table.
  if (token.type === 'table') {
    const table = token as Tokens.Table;
    for (const cell of [...table.header, ...table.rows.flat()]) children.push(...cell.tokens);
  }
  return children;
}

function collect(tokens: Token[], found: Set<string>): void {
  for (const token of tokens) {
    switch (token.type) {
      case 'image':
        found.add(Construct.Image);
        break;
      case 'del':
        found.add(Construct.Strikethrough);
        break;
      case 'html':
        found.add(Construct.RawHtml);
        break;
      case 'heading':
        if ((token as Tokens.Heading).depth >= 4) found.add(Construct.DeepHeading);
        break;
      case 'list':
        if ((token as Tokens.List).items.some((item) => item.task)) found.add(Construct.TaskList);
        break;
      case 'text':
        // Matched post-tokenizing, so code blocks and backtick spans are
        // already out of the way.
        if (HIGHLIGHT.test(token.raw)) found.add(Construct.Highlight);
        break;
      case 'link':
      case 'def':
        // marked has no footnote extension loaded, so `[^1]` arrives as a
        // reference link and `[^1]: text` as its definition.
        if (token.raw.startsWith('[^')) found.add(Construct.Footnote);
        break;
    }

    collect(childTokens(token), found);
  }
}

export function markdownConstructs(markdown: string): string[] {
  const found = new Set<string>();
  collect(lexer(markdown), found);
  return [...found].sort();
}
