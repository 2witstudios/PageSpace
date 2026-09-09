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
 * exhaustively-named allowlist (`ALLOWED_COSMETIC_ADDITIONS`, in
 * `seed-fidelity.ts`, shared with `scripts/collab-seed-audit.ts` so the corpus
 * and real documents are held to ONE list) which the suite also asserts is not
 * larger than it needs to be. A rewrite that is not on the
 * list fails, whether it is new or newly noticed.
 */
import { describe, it, expect } from 'vitest';
import { htmlToPmDoc, describeHtmlLoss } from '../html-to-ydoc.js';
import { pmDocToHtml } from '../y-doc-to-html.js';
import { withDomWorkspace } from '../dom-workspace.js';
import {
  ALLOWED_COSMETIC_ADDITIONS,
  PRINTABLE_ATTRIBUTE_VALUES,
  VALUE_BEARING_ATTRIBUTES,
  constructKeysOf,
  contentFreeKey,
  constructDifference as difference,
} from '../seed-fidelity.js';
import {
  CONSTRUCT_CORPUS,
  CORPUS_CASES,
  corpusDocumentHtml,
} from './support/construct-corpus.js';

/** `constructKeysOf` over a markup string, in a throwaway workspace. */
function constructsOf(html: string): Set<string> {
  return withDomWorkspace((workspace) => constructKeysOf(workspace.parse(html)));
}

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

describe('printable attribute values', () => {
  it('are a subset of the value-bearing attributes — a value that is never in a key needs no printability rule', () => {
    expect([...PRINTABLE_ATTRIBUTE_VALUES].filter((name) => !VALUE_BEARING_ATTRIBUTES.has(name))).toEqual([]);
  });

  it('keep enumerations and fold prose, urls and ids back to presence', () => {
    expect(contentFreeKey('attr:ul@data-type=taskList')).toBe('attr:ul@data-type=taskList');
    expect(contentFreeKey('attr:td@colspan=2')).toBe('attr:td@colspan=2');
    expect(contentFreeKey('attr:img@alt=a photo of Ada')).toBe('attr:img@alt');
    expect(contentFreeKey('attr:a@href=https://x.test/ada-lovelace')).toBe('attr:a@href');
    expect(contentFreeKey('attr:a@data-page-id=pg_1')).toBe('attr:a@data-page-id');
    expect(contentFreeKey('el:img')).toBe('el:img');
  });

  it('every value-bearing attribute that is not printable is one whose value could be content or an identifier', () => {
    // The complement is the list a reader should check when adding to either set.
    expect([...VALUE_BEARING_ATTRIBUTES].filter((name) => !PRINTABLE_ATTRIBUTE_VALUES.has(name)).sort()).toEqual([
      'alt', 'data-block-id', 'data-change-id', 'data-change-type', 'data-drive-id', 'data-file-id',
      'data-page-id', 'data-role-id', 'data-user-id', 'href',
    ]);
  });
});
