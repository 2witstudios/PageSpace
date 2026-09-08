/**
 * The seed invariant, over the construct corpus.
 *
 * The bar is `render(parse(h1)) == h1` — a FIXPOINT — plus zero loss of any
 * content-bearing construct. It is deliberately NOT byte-identical output,
 * because measured over the corpus one pass through the schema rewrites its
 * input in ways that lose nothing: tables gain `<colgroup>` and `min-width`,
 * a bare `<ul>` gains `class="tight" data-tight="true"`, bare `<li>` text is
 * wrapped in `<p>`, `TaskItem` renders its own checkbox markup, `Link` stamps
 * `target`/`rel`. A byte-equality assertion here would fail on all of that and
 * send its next reader off to "fix" normalisation that is not broken.
 *
 * The danger in relaxing an assertion is that the relaxation swallows a real
 * loss. So the tolerance is NOT a loose comparison — it is an explicit,
 * exhaustively-named allowlist (`ALLOWED_COSMETIC_ADDITIONS`) which the suite
 * also asserts is not larger than it needs to be. A rewrite that is not on the
 * list fails, whether it is new or newly noticed.
 */
import { describe, it, expect } from 'vitest';
import { htmlToPmDoc, describeHtmlLoss } from '../html-to-ydoc.js';
import { pmDocToHtml } from '../y-doc-to-html.js';
import { withDomWorkspace } from '../dom-workspace.js';
import {
  CONSTRUCT_CORPUS,
  CORPUS_CASES,
  corpusDocumentHtml,
} from './support/construct-corpus.js';

/**
 * Every markup construct one pass through the schema is allowed to ADD.
 *
 * Each entry is a rewrite whose absence from the source is not information:
 *
 * - `a@target` / `a@rel` — `Link` stamps these on every anchor it renders.
 * - `a@data-type`, `span@data-type` — TipTap's node-name marker on a mention.
 * - `a@contenteditable`, `a@data-drive-id` — the AI mention dialect omits
 *   them; the node's own `renderHTML` always writes them.
 * - `ul@class`, `ul@data-tight` — `MarkdownTightLists` makes the tightness it
 *   INFERRED from the source (`!element.querySelector('p')`) explicit.
 * - `p` — a bare `<li>text</li>` becomes `<li><p>text</p></li>`, because the
 *   schema's `listItem` content is `paragraph block*`.
 * - `label`, `input`, `input@type`, `input@checked`, `span`, `div` —
 *   `TaskItem`'s rendered checkbox. The state itself lives in
 *   `li@data-checked`, which the source already carried.
 * - `pre@class` — `CodeBlockNode` mirrors `language-x` onto the `<pre>`.
 * - `table@style`, `colgroup`, `col`, `col@style` (and their `style:min-width`
 *   forms) — TipTap's table column model, emitted as `min-width` from the
 *   schema's own defaults.
 *
 * The `=pageMention` entries are the VALUE-bearing form of the `data-type`
 * marker above. They are listed separately, and deliberately: it is the value
 * that carries the meaning, so `data-type` changing from `taskList` to
 * `taskItem` must fail rather than be absorbed by a bare `attr@data-type`.
 *
 * Nothing here changes what the document SAYS. An addition outside this set is
 * a change to the stored dialect and must be looked at, not tolerated.
 */
const ALLOWED_COSMETIC_ADDITIONS: ReadonlySet<string> = new Set([
  'attr:a@contenteditable',
  'attr:a@data-drive-id',
  'attr:a@data-type',
  'attr:a@data-type=pageMention',
  'attr:a@rel',
  'attr:a@target',
  'attr:col@style',
  'attr:col@style:min-width',
  'attr:input@checked',
  'attr:input@type',
  'attr:pre@class',
  'attr:span@data-type',
  'attr:span@data-type=pageMention',
  'attr:table@style',
  'attr:table@style:min-width',
  'attr:ul@class',
  'attr:ul@data-tight',
  'el:col',
  'el:colgroup',
  'el:div',
  'el:input',
  'el:label',
  'el:p',
  'el:span',
]);

/**
 * Markup constructs as comparable keys: `el:<tag>`, `attr:<tag>@<name>`, and —
 * for the two attributes whose VALUE is the construct — `attr:<tag>@<name>=<value>`.
 * Deliberately not the markup string: a set difference names WHICH construct
 * moved, where a string diff only says "changed".
 *
 * `style` is split per CSS property and `data-type` carries its value, because
 * a bare `attr:p@style` merges the question with the answer. `text-align:center`
 * becoming `text-align:left`, or `data-type="taskList"` becoming `taskItem`,
 * would otherwise be invisible to a gate whose entire job is naming the
 * construct that moved — and the corpus has fixtures for both.
 */
function constructsOf(html: string): Set<string> {
  return withDomWorkspace((workspace) => {
    const keys = new Set<string>();
    const walk = (element: Element): void => {
      const tag = element.tagName.toLowerCase();
      keys.add(`el:${tag}`);
      for (const name of element.getAttributeNames()) {
        keys.add(`attr:${tag}@${name}`);
        if (name === 'data-type') {
          keys.add(`attr:${tag}@data-type=${element.getAttribute(name) ?? ''}`);
        }
        if (name === 'style') {
          for (const declaration of (element.getAttribute(name) ?? '').split(';')) {
            const property = declaration.split(':')[0]?.trim().toLowerCase();
            if (property) {
              keys.add(`attr:${tag}@style:${property}`);
            }
          }
        }
      }
      for (const child of Array.from(element.children)) {
        walk(child);
      }
    };
    for (const child of Array.from(workspace.parse(html).children)) {
      walk(child);
    }
    return keys;
  });
}

const difference = (a: Set<string>, b: Set<string>): string[] =>
  [...a].filter((key) => !b.has(key)).sort();

describe.each(CORPUS_CASES)(
  'seed fidelity: %s',
  (_key, fixture) => {
    const rendered = pmDocToHtml(htmlToPmDoc(fixture.html));

    it('reaches a fixpoint in one pass', () => {
      expect(pmDocToHtml(htmlToPmDoc(rendered))).toBe(rendered);
    });

    it('loses no construct the source carried', () => {
      expect(difference(constructsOf(fixture.html), constructsOf(rendered))).toEqual([]);
    });

    it('adds only allowlisted cosmetic constructs', () => {
      const added = difference(constructsOf(rendered), constructsOf(fixture.html));
      expect(added.filter((key) => !ALLOWED_COSMETIC_ADDITIONS.has(key))).toEqual([]);
    });

    // No "preserves every visible character" test here. It would recompute
    // `visibleCharacters(source.textContent) === visibleCharacters(pmDocToText(...))`,
    // which is exactly what `describeHtmlLoss` does below — a mirror that
    // cannot fail unless the next test fails first, and whose duplicated
    // whitespace rule would silently drift from the implementation's. The
    // independent check on the same property is in `projections.test.ts`,
    // where each fixture's expected visible strings are hand-written rather
    // than derived from the code under test.
    it('reports no loss', () => {
      expect(describeHtmlLoss(fixture.html)).toEqual([]);
    });
  },
);

describe('the corpus as one document', () => {
  it('reaches a fixpoint and loses nothing', () => {
    const source = corpusDocumentHtml();
    const rendered = pmDocToHtml(htmlToPmDoc(source));
    expect(describeHtmlLoss(source)).toEqual([]);
    expect(difference(constructsOf(source), constructsOf(rendered))).toEqual([]);
    expect(pmDocToHtml(htmlToPmDoc(rendered))).toBe(rendered);
  });
});

describe('the allowlist itself', () => {
  /**
   * Without this, a rewrite that stops happening leaves a stale entry behind,
   * and the allowlist grows into a blanket tolerance that would hide the next
   * real change. Every entry must be earned by the corpus.
   */
  it('contains nothing the corpus does not actually produce', () => {
    // Per fixture, then unioned — NOT over the concatenated document. In the
    // concatenation a construct one fixture gains is already present in
    // another fixture's source, so five real rewrites (`el:p`, `el:span`,
    // `a@rel`, `a@contenteditable`, `a@data-drive-id`) would read as never
    // produced and this guard would demand their removal from the allowlist.
    const produced = CONSTRUCT_CORPUS.flatMap((fixture) =>
      difference(
        constructsOf(pmDocToHtml(htmlToPmDoc(fixture.html))),
        constructsOf(fixture.html),
      ),
    );
    expect([...ALLOWED_COSMETIC_ADDITIONS].sort().filter((key) => !produced.includes(key))).toEqual(
      [],
    );
  });
});
