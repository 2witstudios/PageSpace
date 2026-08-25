import { lexer, type Token, type Tokens } from 'marked';
import { classifyImageSource, type ImageSource } from './images';
import { emptyMagnitudes, lineCount, type Magnitudes } from './magnitudes';

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
 *
 * Only syntax the schema has NO home for is listed. `~~strikethrough~~` was
 * here and is not: StarterKit ships the `strike` mark and the bubble menu
 * exposes it, so counting it as a gap put 17 documents in a table headed
 * "source syntax the schema has no node for" that the schema represents
 * perfectly well. `round-trip.test.ts` holds the schema to that.
 */
const enum Construct {
  Image = 'md:image',
  TaskList = 'md:task-list',
  DeepHeading = 'md:heading-4-6',
  RawHtml = 'md:raw-html',
  Footnote = 'md:footnote',
  Highlight = 'md:highlight',
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

/**
 * Everything one pass of the lexer can answer, gathered in that one pass.
 *
 * The census re-reads the whole `pages` table to produce this, and after the
 * mislabelled population is routed through here too it re-reads most of it
 * twice. Lexing markdown three times to answer three questions about it is the
 * kind of cost that turns a scan into an afternoon.
 */
export interface MarkdownAnalysis {
  constructs: string[];
  /** Scheme buckets and bare hostnames — never a URL. See `images.ts`. */
  images: ImageSource[];
  magnitudes: Magnitudes;
}

interface Walk {
  found: Set<string>;
  images: ImageSource[];
  magnitudes: Magnitudes;
}

/** Markdown tokens the editor renders as one block the paginator cannot split. */
const BLOCK_TOKEN_TYPES = new Set(['paragraph', 'heading', 'blockquote', 'code', 'list_item']);

function collect(tokens: Token[], walk: Walk): void {
  const { found } = walk;
  for (const token of tokens) {
    if (BLOCK_TOKEN_TYPES.has(token.type)) {
      walk.magnitudes.blockCharacters = Math.max(walk.magnitudes.blockCharacters, token.raw.length);
    }

    switch (token.type) {
      case 'image':
        found.add(Construct.Image);
        walk.magnitudes.images += 1;
        walk.images.push(classifyImageSource((token as Tokens.Image).href ?? ''));
        break;
      case 'code': {
        walk.magnitudes.codeBlockLines = Math.max(
          walk.magnitudes.codeBlockLines,
          lineCount((token as Tokens.Code).text),
        );
        break;
      }
      case 'table': {
        const table = token as Tokens.Table;
        // The header is a row on the page even though `marked` keeps it apart
        // from `rows`, and a table that overflows a page overflows it by one
        // row more than `rows.length` says.
        walk.magnitudes.tableRows = Math.max(walk.magnitudes.tableRows, table.rows.length + 1);
        walk.magnitudes.tableColumns = Math.max(walk.magnitudes.tableColumns, table.header.length);
        break;
      }
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

    collect(childTokens(token), walk);
  }
}

export function analyzeMarkdown(markdown: string): MarkdownAnalysis {
  const walk: Walk = { found: new Set<string>(), images: [], magnitudes: emptyMagnitudes() };
  collect(lexer(markdown), walk);
  return {
    constructs: [...walk.found].sort(),
    images: walk.images,
    magnitudes: walk.magnitudes,
  };
}

export function markdownConstructs(markdown: string): string[] {
  return analyzeMarkdown(markdown).constructs;
}
