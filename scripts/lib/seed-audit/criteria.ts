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
 * `spaceCollapsedText` exists for that: the weaker (single-space) form, whose
 * mismatches are reported as a diagnostic count, never as a verdict.
 */
export function visibleText(root: Element): string {
  return visibleCharacters(root.textContent ?? '');
}

/** Whitespace runs collapsed to one space and trimmed — diagnostic only; see `visibleText`. */
export function spaceCollapsedText(root: Element): string {
  return (root.textContent ?? '').replace(/\s+/gu, ' ').trim();
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
