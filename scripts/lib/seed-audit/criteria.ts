import { hasRealHtmlElement } from '@pagespace/editor/html-element-names';
import { visibleCharacters } from '@pagespace/editor/html-to-ydoc';

/**
 * The three seed-fidelity criteria, as pure functions over a parsed DOM.
 *
 * Taken from the Phase B leaf ("Seed fidelity gate over real documents"),
 * which corrected the plan's "lossy rate ~0" into three hard blockers with no
 * thresholds:
 *
 *  1. STABILITY — `h1 = render(parse(src))`, `h2 = render(parse(h1))`,
 *     require `h1 == h2`. A page that fails is a document whose projection
 *     churns forever. (Byte equality IS the right bar here: h1 is already in
 *     the schema's own dialect.)
 *  2. CONTENT-BEARING LOSS — instance COUNTS of the constructs below, `src`
 *     vs `h1`. Any decrease in any counter is loss. Increases are not: a bare
 *     `<li>` gaining a `<p>`, or `TaskItem` rendering its own `<input>`, add
 *     markup without changing what the document says.
 *  3. TEXT PRESERVATION — whitespace-collapsed `textContent` of `src` must
 *     equal that of `h1`.
 *
 * "Byte-identical" between `src` and `h1` is the WRONG bar — see
 * `@pagespace/editor/seed-fidelity` for the allowlist of cosmetic rewrites one
 * pass through the schema makes. That allowlist is used by `analyze.ts` to
 * name additions OUTSIDE it; nothing in this file tolerates anything.
 */

/**
 * The counters the leaf names, verbatim, one per selector. Kept as separate
 * rows rather than the leaf's groups (`h4`–`h6`, `table`/`tr`/`td`/`th`) so a
 * decrease names the exact construct.
 *
 * `div`: the leaf says "non-semantic `div` wrappers". `TaskItem`'s own
 * rendering puts a `<div>` around each item's content, and the TipTap markup
 * already stored for task lists carries the same `<div>` — so those are
 * excluded on BOTH sides, or a document could lose a genuine wrapper `<div>`
 * while its task items "pay it back" and the counter never moves.
 */
export interface ContentCounter {
  readonly key: string;
  count(root: Element): number;
}

/** A counter that reports how many elements in the page match `selector`. */
function bySelector(key: string, selector: string): ContentCounter {
  return { key, count: (root) => root.querySelectorAll(selector).length };
}

const TASK_ITEM_SELECTOR = 'li[data-type="taskItem"]';

export const CONTENT_COUNTERS: readonly ContentCounter[] = [
  bySelector('img', 'img'),
  bySelector('h4', 'h4'),
  bySelector('h5', 'h5'),
  bySelector('h6', 'h6'),
  bySelector('table', 'table'),
  bySelector('tr', 'tr'),
  bySelector('td', 'td'),
  bySelector('th', 'th'),
  bySelector('li', 'li'),
  bySelector('pre', 'pre'),
  bySelector('code', 'code'),
  bySelector('a[data-page-id]', 'a[data-page-id]'),
  bySelector('span[data-mention-type]', 'span[data-mention-type]'),
  bySelector('mark', 'mark'),
  bySelector('sup', 'sup'),
  bySelector('sub', 'sub'),
  bySelector('iframe', 'iframe'),
  bySelector('details', 'details'),
  {
    key: 'div (outside task items)',
    // Only TaskItem's OWN wrapper — the direct child of the item — is chrome.
    // A `<div>` nested deeper inside a task item is the author's, and losing
    // it must count.
    count: (root) =>
      Array.from(root.querySelectorAll('div')).filter(
        (div) => !(div.parentElement?.matches(TASK_ITEM_SELECTOR) ?? false),
      ).length,
  },
  bySelector('input[type=checkbox]', 'input[type="checkbox"]'),
];

export type ContentCounts = Readonly<Record<string, number>>;

/** Every counter's value for one page — the `src` and `h1` inputs to criterion 2. */
export function countContent(root: Element): ContentCounts {
  const counts: Record<string, number> = {};
  for (const counter of CONTENT_COUNTERS) {
    counts[counter.key] = counter.count(root);
  }
  return counts;
}

/** Counter keys whose count in `after` is lower than in `before`, in counter order. Never the counts themselves. */
export function counterDecreases(before: ContentCounts, after: ContentCounts): string[] {
  return CONTENT_COUNTERS.map((counter) => counter.key).filter(
    (key) => (after[key] ?? 0) < (before[key] ?? 0),
  );
}

/**
 * The leaf's "whitespace-collapsed `textContent`", with the collapse taken
 * all the way to zero whitespace.
 *
 * Collapsing runs to a single space is not enough: stored HTML is often
 * pretty-printed, and the newline-and-indent between two `<p>` blocks is a
 * text node whose `textContent` is whitespace ProseMirror correctly drops.
 * `<p>a</p>\n  <p>b</p>` would read `a b` in and `ab` out, and every
 * pretty-printed document in the corpus would fail criterion 3 for a reason
 * that is not loss. Stripping all whitespace compares the sequence of visible
 * characters, which is what must not change — and it IS the seed gate's own
 * rule: `visibleCharacters` from `html-to-ydoc.ts`, not a copy of it. The
 * source is measured after `stripNonContentElements` (same module) so a
 * `<style>` block's CSS is not reported as lost prose.
 *
 * The cost is that a space vanishing BETWEEN two words is invisible here.
 * `interWordText` exists for that, as a diagnostic count and never a verdict.
 */
export function visibleText(root: Element): string {
  return visibleCharacters(root.textContent ?? '');
}

/** DOM node types, per the DOM's own `Node` constants. */
const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/**
 * Elements that begin and end a line of prose. Whitespace BETWEEN two of them
 * is the pretty-printer's; whitespace between two inline things is the
 * author's. That is the whole distinction `interWordText` turns on, so the set
 * is listed rather than inferred — happy-dom has no layout engine to ask.
 */
const BLOCK_ELEMENTS: ReadonlySet<string> = new Set([
  'address', 'article', 'aside', 'blockquote', 'caption', 'col', 'colgroup', 'dd', 'details',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'iframe', 'li', 'main', 'nav', 'ol', 'p', 'pre',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

/** A run of document text, or the edge of a block. */
type Segment = { boundary: true } | { boundary: false; text: string; verbatim: boolean };

/**
 * Text with the spacing BETWEEN words kept and the spacing between BLOCKS
 * discarded — the weaker comparison behind the `whitespaceOnlyTextChange`
 * diagnostic.
 *
 * Collapsing the whole document's `textContent` cannot do this: in
 * pretty-printed HTML the newline-and-indent between two `<p>` is itself a
 * text node, so `<p>a</p>\n  <p>b</p>` reads `a b` while the schema's own
 * `<p>a</p><p>b</p>` reads `ab`, and the diagnostic fires on every
 * pretty-printed page — saying "pretty-printed", not "a space was lost".
 *
 * Dropping every whitespace-only node is not the fix either, and gets the
 * question backwards: in `a<span> </span>b` — the shape HTML pasted from Word
 * and Docs is full of — that node IS the space between the words. Dropping it
 * makes a page where the space SURVIVED read `ab`, identical to one where it
 * was lost, so the single class of loss this function exists to see becomes
 * the one it cannot see.
 *
 * So the rule is positional: a whitespace-only run is formatting when a block
 * edge is on either side of it, and content when inline text is on both.
 * Inside `<pre>`, where whitespace is the content, text is kept verbatim —
 * otherwise a code block that lost every indent would read as unchanged, and
 * `visibleText` (which strips all whitespace) cannot see that either.
 *
 * Known and deliberate: a non-breaking space is treated as a space, so an
 * `&nbsp;` rewritten to U+0020 does not show up here. It is a diagnostic, not
 * a criterion, and no verdict rests on it.
 */
export function interWordText(root: Element): string {
  const segments: Segment[] = [];
  /** Flattens the tree to segments, marking block edges and `<pre>` content. */
  const walk = (node: Node, verbatim: boolean): void => {
    if (node.nodeType === TEXT_NODE) {
      segments.push({ boundary: false, text: node.nodeValue ?? '', verbatim });
      return;
    }
    // Comments and processing instructions carry no prose.
    if (node.nodeType !== ELEMENT_NODE) return;

    const tag = (node as Element).tagName.toLowerCase();
    const isBlock = BLOCK_ELEMENTS.has(tag);
    if (isBlock) segments.push({ boundary: true });
    for (const child of Array.from(node.childNodes)) walk(child, verbatim || tag === 'pre');
    if (isBlock) segments.push({ boundary: true });
  };
  walk(root, false);

  /** Whether the segment at `index` is the pretty-printer's whitespace rather than the author's. */
  const isFormatting = (index: number): boolean => {
    const segment = segments[index];
    if (segment.boundary || segment.verbatim || /\S/u.test(segment.text)) return false;
    // The nearest thing on each side that is not itself blank space.
    const meaningful = (from: number, step: number): Segment | undefined => {
      for (let i = from; i >= 0 && i < segments.length; i += step) {
        const candidate = segments[i];
        if (candidate.boundary || /\S/u.test(candidate.text)) return candidate;
      }
      return undefined;
    };
    const before = meaningful(index - 1, -1);
    const after = meaningful(index + 1, 1);
    // Missing counts as a boundary: leading and trailing space is not between words.
    return before === undefined || before.boundary || after === undefined || after.boundary;
  };

  return segments
    .map((segment, index) => {
      if (segment.boundary || isFormatting(index)) return '';
      return segment.verbatim ? segment.text : segment.text.replace(/\s+/gu, ' ');
    })
    .join('')
    .trim();
}

/**
 * Whether a stored `contentMode='html'` document contains no REAL HTML
 * element. A page with none is markdown (or plain text) filed under the wrong
 * content mode; the content census found 3,003 of them and the
 * mislabelled-content backfill has since corrected 2,718. Seeding one through
 * the HTML path flattens every heading, list and code fence into a single
 * paragraph, permanently — so Phase E must refuse them, and this audit counts
 * them separately rather than letting them pass criterion 2 with every
 * counter at zero.
 *
 * "Real" is the census's and the backfill's definition (`HTML_ELEMENT_NAMES`):
 * `Set<string>` in a markdown page makes happy-dom create a `<string>`
 * element, and a rule of "any element at all" would call that page HTML.
 */
export function isTagless(root: Element): boolean {
  return !hasRealHtmlElement(root);
}
