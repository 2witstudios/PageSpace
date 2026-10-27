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
    expect([...PRINTABLE_ATTRIBUTE_VALUES.keys()].filter((name) => !VALUE_BEARING_ATTRIBUTES.has(name))).toEqual([]);
  });

  it('every value-bearing attribute that is not printable is one whose value could be content or an identifier', () => {
    // The complement is the list a reader should check when adding to either set.
    expect([...VALUE_BEARING_ATTRIBUTES].filter((name) => !PRINTABLE_ATTRIBUTE_VALUES.has(name)).sort()).toEqual([
      'alt', 'data-block-id', 'data-change-id', 'data-change-type', 'data-drive-id', 'data-file-id',
      'data-page-id', 'data-role-id', 'data-user-id', 'href',
    ]);
  });
});

describe('contentFreeKey', () => {
  it('keeps values the schema itself enumerates', () => {
    expect(contentFreeKey('attr:ul@data-type=taskList')).toBe('attr:ul@data-type=taskList');
    expect(contentFreeKey('attr:li@data-checked=true')).toBe('attr:li@data-checked=true');
    expect(contentFreeKey('attr:td@colspan=2')).toBe('attr:td@colspan=2');
    expect(contentFreeKey('attr:ol@start=7')).toBe('attr:ol@start=7');
    expect(contentFreeKey('attr:p@style:text-align')).toBe('attr:p@style:text-align');
    expect(contentFreeKey('el:img')).toBe('el:img');
  });

  it('withholds prose, urls and ids while keeping the key marked as a VALUE key', () => {
    // `=(withheld)` rather than the bare presence key: `constructKeysOf` emits
    // both forms so a dropped attribute and a changed one stay distinguishable,
    // and collapsing to presence here would undo that at the last step.
    expect(contentFreeKey('attr:img@alt=a photo of Ada')).toBe('attr:img@alt=(withheld)');
    expect(contentFreeKey('attr:a@href=https://x.test/ada-lovelace')).toBe('attr:a@href=(withheld)');
    expect(contentFreeKey('attr:a@data-page-id=pg_1')).toBe('attr:a@data-page-id=(withheld)');
    // The presence key is untouched, so the two remain different rows.
    expect(contentFreeKey('attr:img@alt')).toBe('attr:img@alt');
  });

  it('withholds a printable attribute whose value is not one the schema renders', () => {
    expect(contentFreeKey('attr:span@data-type=customer-name')).toBe('attr:span@data-type=(withheld)');
    expect(contentFreeKey('attr:li@data-checked=SECRET')).toBe('attr:li@data-checked=(withheld)');
    expect(contentFreeKey('attr:ol@start=SECRET_START')).toBe('attr:ol@start=(withheld)');
    expect(contentFreeKey('attr:td@colspan=1234567')).toBe('attr:td@colspan=(withheld)');
  });

  it('never withholds a value into a key that is itself on the cosmetic allowlist', () => {
    // Without the `=(withheld)` marker an author-typed `data-type` would print
    // as `attr:a@data-type`, which IS allowlisted — a finding wearing the key
    // of a non-finding.
    for (const key of ['attr:a@data-type=customer-name', 'attr:ul@data-tight=maybe', 'attr:td@colspan=x']) {
      expect(ALLOWED_COSMETIC_ADDITIONS.has(contentFreeKey(key)), key).toBe(false);
    }
  });

  it('folds names the author could have typed: unknown tags, odd attribute names, custom properties', () => {
    expect(contentFreeKey('el:secret-tag')).toBe('text:unescaped-angle-bracket');
    expect(contentFreeKey('attr:secret-tag@class')).toBe('text:unescaped-angle-bracket');
    expect(contentFreeKey('attr:p@secret_attr_name')).toBe('attr:p@(unrecognised-attribute)');
    expect(contentFreeKey('attr:p@secretattr')).toBe('attr:p@(unrecognised-attribute)');
    expect(contentFreeKey('attr:p@data-secret=x')).toBe('attr:p@(unrecognised-attribute)=(withheld)');
    expect(contentFreeKey('attr:p@style:--secret-name')).toBe('attr:p@style:(unrecognised-property)');
    expect(contentFreeKey('attr:p@style:secret_prop')).toBe('attr:p@style:(unrecognised-property)');
    expect(contentFreeKey('attr:p@style:margin-top')).toBe('attr:p@style:margin-top');
  });

  it('FAILS CLOSED on a key it cannot decompose, rather than handing back its input', () => {
    // happy-dom builds a real element for a tag name starting with `@`, so a
    // pasted FreeMarker directive or Slack mention produces `attr:@list@items`
    // — which the attribute pattern cannot split, because its tag group needs
    // one non-`@` character. Returning the input there printed a Slack user id
    // and a full href straight into the report.
    expect(contentFreeKey('attr:@u08jane.doe@email=jane.doe@acme.com')).toBe('text:unescaped-angle-bracket');
    expect(contentFreeKey('attr:@list@items=payroll-2026-Q1.csv')).toBe('text:unescaped-angle-bracket');
    expect(contentFreeKey('attr:@p@href=https://secret.example/a')).toBe('text:unescaped-angle-bracket');
    expect(contentFreeKey('attr:@x@style:color')).toBe('text:unescaped-angle-bracket');
    expect(contentFreeKey('not a key at all')).toBe('text:unescaped-angle-bracket');
    // The marker itself is the one thing that survives, or folding would not
    // be idempotent.
    expect(contentFreeKey('text:unescaped-angle-bracket')).toBe('text:unescaped-angle-bracket');
    expect(contentFreeKey(contentFreeKey('attr:@list@items=x'))).toBe('text:unescaped-angle-bracket');
  });

  it('bounds every key it returns, so one document cannot pad the whole report', () => {
    const long = 'a'.repeat(5000);
    for (const key of [`el:${long}`, `attr:p@${long}`, `attr:p@style:${long}`, `attr:p@alt=${long}`, `attr:@${long}@x=${long}`]) {
      expect(contentFreeKey(key).length, key.slice(0, 30)).toBeLessThanOrEqual(64);
    }
  });
});

describe('the corpus reports only recognised names', () => {
  it('folds nothing the schema renders — every corpus key is already content-free', () => {
    for (const fixture of CONSTRUCT_CORPUS) {
      const rendered = constructsOf(pmDocToHtml(htmlToPmDoc(fixture.html)));
      for (const key of rendered) {
        if (VALUE_BEARING_ATTRIBUTES.has(/@([^=]+)=/u.exec(key)?.[1] ?? '') && !PRINTABLE_ATTRIBUTE_VALUES.has(/@([^=]+)=/u.exec(key)?.[1] ?? '')) continue;
        expect(contentFreeKey(key), key).toBe(key);
      }
    }
  });
});
