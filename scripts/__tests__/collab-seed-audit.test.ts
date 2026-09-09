/**
 * The seed fidelity audit (`scripts/collab-seed-audit.ts`), tested through
 * its pure modules in `scripts/lib/seed-audit/`.
 *
 * The three criteria are hard blockers, so what matters most here is that
 * each one can actually go red: every test that asserts "lossy" was
 * mutation-checked by breaking the mechanism it names (see the PR report).
 * Everything else is the audit's two promises to production — it never
 * writes, and it never prints content — held as tests rather than as prose.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDomWorkspace, type DomWorkspace } from '@pagespace/editor/dom-workspace';
import {
  CONTENT_COUNTERS,
  countContent,
  counterDecreases,
  isTagless,
  spaceCollapsedText,
  stripNonContentElements,
  visibleText,
} from '../lib/seed-audit/criteria';
import {
  auditPage,
  divergenceBetween,
  gateReasonShape,
  isLossy,
  judgeChain,
  type PageAudit,
} from '../lib/seed-audit/analyze';
import {
  auditPassed,
  censusKeyOf,
  contentFreeKey,
  createAuditAccumulator,
  formatAuditReport,
} from '../lib/seed-audit/report';
import { parseAuditArgs } from '../lib/seed-audit/options';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.resolve(here, '..');

/** One window for the file; every `parse` is a fresh detached element. */
let workspace: DomWorkspace;
beforeAll(() => {
  workspace = createDomWorkspace();
});
afterAll(() => {
  workspace.close();
});

const parse = (html: string): Element => workspace.parse(html);

/** A clean audit, as a fixture other tests narrow. */
const CLEAN_HTML =
  '<h1>Title</h1><p>Some <strong>prose</strong> with <a href="https://example.test/">a link</a>.</p>' +
  '<ul><li><p>alpha</p></li><li><p>beta</p></li></ul>' +
  '<table><tbody><tr><th colspan="1" rowspan="1"><p>Name</p></th></tr>' +
  '<tr><td colspan="1" rowspan="1"><p>Ada</p></td></tr></tbody></table>' +
  '<pre><code class="language-ts">const x = 1;</code></pre>';

function audited(audit: PageAudit): PageAudit & { status: 'audited' } {
  if (audit.status !== 'audited') {
    throw new Error(`expected an audited page, got ${audit.status}`);
  }
  return audit;
}

describe('content counters (criterion 2)', () => {
  it('counts every construct the leaf names, per instance', () => {
    const counts = countContent(
      parse(
        '<img><h4>a</h4><h5>b</h5><h6>c</h6>' +
          '<table><tr><th>h</th><td>d</td><td>e</td></tr></table>' +
          '<ul><li>1</li><li>2</li><li>3</li></ul>' +
          '<pre><code>x</code></pre><p><code>y</code></p>' +
          '<p><a data-page-id="pg_1">@p</a><span data-mention-type="role">@r</span></p>' +
          '<p><mark>m</mark><sup>s</sup><sub>t</sub></p>' +
          '<iframe></iframe><details></details><div><div></div></div>' +
          '<input type="checkbox">',
      ),
    );
    expect(counts).toEqual({
      img: 1,
      h4: 1,
      h5: 1,
      h6: 1,
      table: 1,
      tr: 1,
      td: 2,
      th: 1,
      li: 3,
      pre: 1,
      code: 2,
      'a[data-page-id]': 1,
      'span[data-mention-type]': 1,
      mark: 1,
      sup: 1,
      sub: 1,
      iframe: 1,
      details: 1,
      'div (outside task items)': 2,
      'input[type=checkbox]': 1,
    });
  });

  it('does not count the <div> TaskItem renders inside a task item, so a lost wrapper cannot be paid back by one', () => {
    const counts = countContent(
      parse(
        '<div><p>wrapper</p></div>' +
          '<ul data-type="taskList"><li data-type="taskItem" data-checked="false">' +
          '<label><input type="checkbox"><span></span></label><div><p>todo</p></div></li></ul>',
      ),
    );
    expect(counts['div (outside task items)']).toBe(1);
    expect(counts['input[type=checkbox]']).toBe(1);
  });

  it('reports a decrease and never an increase', () => {
    const before = countContent(parse('<ul><li>a</li><li>b</li></ul><img>'));
    const after = countContent(parse('<ul><li><p>a</p></li><li><p>b</p></li></ul><p><p>'));
    expect(counterDecreases(before, after)).toEqual(['img']);
    expect(counterDecreases(after, before)).toEqual([]);
  });

  it('treats a counter missing from either side as zero', () => {
    expect(counterDecreases({ img: 2 }, {})).toEqual(['img']);
    expect(counterDecreases({}, { img: 2 })).toEqual([]);
  });

  it('has one row per construct the leaf names', () => {
    expect(CONTENT_COUNTERS.map((counter) => counter.key)).toEqual([
      'img', 'h4', 'h5', 'h6', 'table', 'tr', 'td', 'th', 'li', 'pre', 'code',
      'a[data-page-id]', 'span[data-mention-type]', 'mark', 'sup', 'sub', 'iframe', 'details',
      'div (outside task items)', 'input[type=checkbox]',
    ]);
  });
});

describe('text (criterion 3)', () => {
  it('compares visible characters with all whitespace stripped, so pretty-printing is not loss', () => {
    expect(visibleText(parse('<p>a b</p>\n  <p>c</p>'))).toBe('abc');
    expect(visibleText(parse('<p>a b</p><p>c</p>'))).toBe('abc');
  });

  it('keeps single spaces in the diagnostic form, so a vanished space is at least visible', () => {
    expect(spaceCollapsedText(parse('<p>a   b</p>\n'))).toBe('a b');
    expect(spaceCollapsedText(parse('<p>ab</p>'))).toBe('ab');
  });

  it('strips script, style, noscript and template before measuring — their text is not prose', () => {
    const root = parse('<p>keep</p><style>p{color:red}</style><script>x()</script><noscript>n</noscript><template>t</template>');
    stripNonContentElements(root);
    expect(visibleText(root)).toBe('keep');
  });

  it('calls a document with no HTML element at all tagless', () => {
    expect(isTagless(parse('# heading\n\nplain markdown'))).toBe(true);
    expect(isTagless(parse('<p>html</p>'))).toBe(false);
  });
});

describe('auditPage — the two chains', () => {
  it('passes a clean document on both chains with no divergence and no gate reason', () => {
    const audit = audited(auditPage(CLEAN_HTML, workspace));
    expect(audit.tagless).toBe(false);
    expect(isLossy(audit.seed)).toBe(false);
    expect(isLossy(audit.census)).toBe(false);
    expect(audit.seed.droppedConstructs).toEqual([]);
    expect(audit.seed.unexpectedAdditions).toEqual([]);
    expect(audit.divergence).toBeNull();
    expect(audit.gateReasons).toEqual([]);
  });

  it('flags an <img> the schema has no node for as a counter decrease, a dropped construct and a gate reason', () => {
    const audit = audited(auditPage('<p>before</p><img src="https://cdn.test/x.png" alt="x"><p>after</p>', workspace));
    expect(audit.seed.counterDecreases).toEqual(['img']);
    expect(audit.seed.droppedConstructs).toContain('el:img');
    expect(audit.seed.textPreserved).toBe(true);
    expect(isLossy(audit.seed)).toBe(true);
    expect(audit.gateReasons).toEqual(['dropped <img>']);
    // The census chain sees the same loss — the schema, not y-prosemirror.
    expect(audit.census.counterDecreases).toEqual(['img']);
    expect(audit.divergence).toBeNull();
  });

  it('flags lost text, and an <iframe>, by criterion 3 and criterion 2 respectively', () => {
    const audit = audited(auditPage('<p>kept</p><iframe src="https://e.test/"></iframe>', workspace));
    expect(audit.seed.counterDecreases).toEqual(['iframe']);
    expect(isLossy(audit.seed)).toBe(true);
  });

  it('does not report a <style> block as lost text', () => {
    const audit = audited(auditPage('<style>p{margin:0}</style><p>prose</p>', workspace));
    expect(audit.seed.textPreserved).toBe(true);
    expect(isLossy(audit.seed)).toBe(false);
  });

  it('accepts the cosmetic rewrites the allowlist names and reports nothing outside it', () => {
    // Bare list, bare cells, bare link: every one of these is rewritten by a
    // pass through the schema, and none of it is loss.
    const audit = audited(
      auditPage('<ul><li>one</li></ul><table><tr><td>c</td></tr></table><p><a href="https://x.test/">l</a></p>', workspace),
    );
    expect(audit.seed.unexpectedAdditions).toEqual([]);
    expect(audit.seed.droppedConstructs).toEqual([]);
    expect(isLossy(audit.seed)).toBe(false);
    expect(audit.seed.stable).toBe(true);
  });

  it('marks a page with no HTML element tagless while still auditing it', () => {
    const audit = audited(auditPage('# Heading\n\n- item', workspace));
    expect(audit.tagless).toBe(true);
    expect(audit.seed.textPreserved).toBe(true);
  });

  it('records a parse failure by stage and error type only', () => {
    const broken: DomWorkspace = {
      ...workspace,
      parse() {
        throw new RangeError('<p>the offending markup</p>');
      },
    };
    expect(auditPage('<p>x</p>', broken)).toEqual({ status: 'failed', stage: 'parse', errorName: 'RangeError' });
  });

  it('attributes a failure after the source parse to the render stage', () => {
    let parses = 0;
    const brokenSecondParse: DomWorkspace = {
      ...workspace,
      parse(html) {
        parses += 1;
        if (parses === 2) throw new TypeError('boom');
        return workspace.parse(html);
      },
    };
    expect(auditPage('<p>x</p>', brokenSecondParse)).toEqual({ status: 'failed', stage: 'render', errorName: 'TypeError' });
  });
});

describe('judgeChain and divergenceBetween (on DOMs, so the branches y-prosemirror has not yet exercised are still covered)', () => {
  it('reports unstable, a counter decrease and lost text as three separate failures', () => {
    const verdict = judgeChain(parse('<p>abc</p><img>'), parse('<p>ab</p>'), false);
    expect(verdict.stable).toBe(false);
    expect(verdict.counterDecreases).toEqual(['img']);
    expect(verdict.textPreserved).toBe(false);
    expect(verdict.whitespaceOnlyTextChange).toBe(false);
    expect(verdict.droppedConstructs).toEqual(['el:img']);
    expect(isLossy(verdict)).toBe(true);
  });

  it('treats instability alone as lossy — a churning projection is a blocker on its own', () => {
    const verdict = judgeChain(parse('<p>a</p>'), parse('<p>a</p>'), false);
    expect(verdict.counterDecreases).toEqual([]);
    expect(verdict.textPreserved).toBe(true);
    expect(isLossy(verdict)).toBe(true);
    expect(isLossy({ ...verdict, stable: true })).toBe(false);
  });

  it('separates a whitespace-only change from lost text', () => {
    const verdict = judgeChain(parse('<p>a b</p>'), parse('<p>ab</p>'), true);
    expect(verdict.textPreserved).toBe(true);
    expect(verdict.whitespaceOnlyTextChange).toBe(true);
    expect(isLossy(verdict)).toBe(false);
  });

  it('names additions outside the allowlist and not those on it', () => {
    const verdict = judgeChain(parse('<ul><li>a</li></ul>'), parse('<ul class="tight" data-tight="true"><li><p>a</p></li></ul><figure></figure>'), true);
    expect(verdict.unexpectedAdditions).toEqual(['el:figure']);
  });

  it('names what the seed projection changed relative to the census projection', () => {
    const divergence = divergenceBetween(parse('<p>ab <mark>c</mark></p><h4>x</h4>'), parse('<p>ab c</p><p>x</p>'));
    expect(divergence).toEqual({
      counterChanges: ['h4', 'mark'],
      textChanged: false,
      constructsLost: ['el:h4', 'el:mark'],
      constructsGained: [],
    });
  });
});

describe('gateReasonShape', () => {
  it('strips the per-page counts off describeHtmlLoss reasons so they tally', () => {
    expect(gateReasonShape('dropped 2 <img> element(s)')).toBe('dropped <img>');
    expect(gateReasonShape('dropped 1 <iframe> element(s)')).toBe('dropped <iframe>');
    expect(gateReasonShape('visible text changed (140 characters in, 120 out)')).toBe('visible text changed');
  });

  it('passes a reason it does not recognise through unchanged', () => {
    expect(gateReasonShape('some future reason')).toBe('some future reason');
  });
});

describe('censusKeyOf', () => {
  it('re-keys tag-qualified constructs the way the content census keys them', () => {
    expect(censusKeyOf('el:img')).toBe('<img>');
    expect(censusKeyOf('attr:p@style:text-align')).toBe('style:text-align');
    expect(censusKeyOf('attr:ul@data-type=taskList')).toBe('attr:data-type=taskList');
    expect(censusKeyOf('attr:a@href=https://x.test/')).toBe('attr:href');
    expect(censusKeyOf('attr:img@src')).toBe('attr:src');
    expect(censusKeyOf('something-else')).toBe('something-else');
  });
});

describe('contentFreeKey', () => {
  it('keeps the values the schema itself enumerates', () => {
    expect(contentFreeKey('attr:ul@data-type=taskList')).toBe('attr:ul@data-type=taskList');
    expect(contentFreeKey('attr:li@data-checked=true')).toBe('attr:li@data-checked=true');
    expect(contentFreeKey('attr:td@colspan=2')).toBe('attr:td@colspan=2');
    expect(contentFreeKey('attr:ol@start=7')).toBe('attr:ol@start=7');
  });

  it('folds prose, urls and ids back to presence', () => {
    expect(contentFreeKey('attr:img@alt=a photo of Ada')).toBe('attr:img@alt');
    expect(contentFreeKey('attr:a@href=https://x.test/ada-lovelace')).toBe('attr:a@href');
    expect(contentFreeKey('attr:a@data-page-id=pg_1')).toBe('attr:a@data-page-id');
    expect(contentFreeKey('el:img')).toBe('el:img');
    expect(contentFreeKey('attr:p@style:text-align')).toBe('attr:p@style:text-align');
  });
});

describe('the accumulator and the report', () => {
  function lossyAudit(overrides: Partial<PageAudit & { status: 'audited' }> = {}): PageAudit {
    return {
      status: 'audited',
      tagless: false,
      census: {
        stable: true,
        counterDecreases: ['img'],
        textPreserved: true,
        whitespaceOnlyTextChange: false,
        droppedConstructs: ['attr:img@src', 'el:img'],
        unexpectedAdditions: [],
      },
      seed: {
        stable: false,
        counterDecreases: ['img'],
        textPreserved: false,
        whitespaceOnlyTextChange: false,
        droppedConstructs: ['attr:img@src', 'el:img'],
        unexpectedAdditions: ['el:figure'],
      },
      divergence: {
        counterChanges: ['img'],
        textChanged: true,
        constructsLost: ['el:h4'],
        constructsGained: ['el:p'],
      },
      gateReasons: ['dropped <img>'],
      ...overrides,
    };
  }

  const cleanAudit = (): PageAudit => audited(auditPage(CLEAN_HTML, workspace));

  it('tallies each criterion, the conjunction, and per-construct example ids', () => {
    const audit = createAuditAccumulator();
    audit.recordHtml('page_1', lossyAudit());
    audit.recordHtml('page_2', cleanAudit());
    const snapshot = audit.snapshot();

    expect(snapshot.totals).toEqual({ documents: 2, audited: 2, markdownMode: 0, empty: 0, tagless: 0, failed: 0, divergent: 1 });
    expect(snapshot.seed.totals).toEqual({ unstable: 1, counterDecreased: 1, textLost: 1, lossy: 1, whitespaceOnlyTextChange: 0 });
    expect(snapshot.census.totals).toEqual({ unstable: 0, counterDecreased: 1, textLost: 0, lossy: 1, whitespaceOnlyTextChange: 0 });
    expect(snapshot.seed.criteriaFailures).toEqual([
      { key: 'counter decreased: img', pages: 1, examplePageIds: ['page_1'] },
      { key: 'text-lost', pages: 1, examplePageIds: ['page_1'] },
      { key: 'unstable', pages: 1, examplePageIds: ['page_1'] },
    ]);
    expect(snapshot.seed.droppedConstructs).toEqual([
      { key: 'attr:img@src', pages: 1, examplePageIds: ['page_1'] },
      { key: 'el:img', pages: 1, examplePageIds: ['page_1'] },
    ]);
    expect(snapshot.seed.droppedConstructsCensusKeyed).toEqual([
      { key: '<img>', pages: 1, examplePageIds: ['page_1'] },
      { key: 'attr:src', pages: 1, examplePageIds: ['page_1'] },
    ]);
    expect(snapshot.seed.unexpectedAdditions).toEqual([{ key: 'el:figure', pages: 1, examplePageIds: ['page_1'] }]);
    expect(snapshot.divergence.rows).toEqual([
      { key: 'counter changed: img', pages: 1, examplePageIds: ['page_1'] },
      { key: 'gained: el:p', pages: 1, examplePageIds: ['page_1'] },
      { key: 'lost: el:h4', pages: 1, examplePageIds: ['page_1'] },
      { key: 'text changed', pages: 1, examplePageIds: ['page_1'] },
    ]);
    expect(auditPassed(snapshot)).toBe(false);
  });

  it('counts one page once per census key even when two tag-qualified keys fold into it', () => {
    const audit = createAuditAccumulator();
    audit.recordHtml(
      'page_1',
      lossyAudit({
        seed: {
          stable: true,
          counterDecreases: [],
          textPreserved: true,
          whitespaceOnlyTextChange: false,
          droppedConstructs: ['attr:h2@style:text-align', 'attr:p@style:text-align'],
          unexpectedAdditions: [],
        },
      }),
    );
    expect(audit.snapshot().seed.droppedConstructsCensusKeyed).toEqual([
      { key: 'style:text-align', pages: 1, examplePageIds: ['page_1'] },
    ]);
  });

  it('names a byte-only divergence rather than letting it hide in a zero', () => {
    const audit = createAuditAccumulator();
    audit.recordHtml(
      'page_1',
      lossyAudit({ divergence: { counterChanges: [], textChanged: false, constructsLost: [], constructsGained: [] } }),
    );
    const snapshot = audit.snapshot();
    expect(snapshot.totals.divergent).toBe(1);
    expect(snapshot.divergence.rows).toEqual([
      { key: 'bytes only (no measured construct, counter or text)', pages: 1, examplePageIds: ['page_1'] },
    ]);
  });

  it('classifies every page into one of the four gate-agreement cells', () => {
    const audit = createAuditAccumulator();
    const cleanSeed = { stable: true, counterDecreases: [], textPreserved: true, whitespaceOnlyTextChange: false, droppedConstructs: [], unexpectedAdditions: [] };
    audit.recordHtml('both_lossy', lossyAudit());
    audit.recordHtml('blind_spot', lossyAudit({ gateReasons: [] }));
    audit.recordHtml('stricter', lossyAudit({ seed: cleanSeed, gateReasons: ['visible text changed'] }));
    audit.recordHtml('both_clean', lossyAudit({ seed: cleanSeed, gateReasons: [] }));
    const { gate } = audit.snapshot();
    expect(gate.agreement).toEqual({ bothLossy: 1, gateBlindSpot: 1, gateStricter: 1, bothClean: 1 });
    expect(gate.agreementRows).toEqual([
      { key: 'bothLossy', pages: 1, examplePageIds: ['both_lossy'] },
      { key: 'gateBlindSpot', pages: 1, examplePageIds: ['blind_spot'] },
      { key: 'gateStricter', pages: 1, examplePageIds: ['stricter'] },
    ]);
    expect(gate.reasons).toEqual([
      { key: 'dropped <img>', pages: 1, examplePageIds: ['both_lossy'] },
      { key: 'visible text changed', pages: 1, examplePageIds: ['stricter'] },
    ]);
  });

  it('keeps at most three example ids per row', () => {
    const audit = createAuditAccumulator();
    for (const id of ['a', 'b', 'c', 'd', 'e']) audit.recordHtml(id, lossyAudit());
    const row = audit.snapshot().seed.criteriaFailures.find((r) => r.key === 'unstable');
    expect(row).toEqual({ key: 'unstable', pages: 5, examplePageIds: ['a', 'b', 'c'] });
  });

  it('counts markdown-mode, empty, tagless and failed pages in the totals and fails the run on a failure', () => {
    const audit = createAuditAccumulator();
    audit.recordMarkdownMode('md');
    audit.recordEmpty();
    audit.recordHtml('tagless', { ...audited(cleanAudit()), tagless: true });
    audit.recordHtml('broken', { status: 'failed', stage: 'parse', errorName: 'RangeError' });
    const snapshot = audit.snapshot();
    expect(snapshot.totals).toEqual({ documents: 4, audited: 2, markdownMode: 1, empty: 1, tagless: 1, failed: 1, divergent: 0 });
    expect(snapshot.taglessPages).toEqual([{ key: 'no HTML element', pages: 1, examplePageIds: ['tagless'] }]);
    expect(snapshot.failures).toEqual([{ key: 'parse: RangeError', pages: 1, examplePageIds: ['broken'] }]);
    expect(snapshot.seed.totals.lossy).toBe(0);
    expect(auditPassed(snapshot)).toBe(false);
  });

  it('passes only when the seed chain has zero lossy pages and nothing failed', () => {
    const audit = createAuditAccumulator();
    audit.recordHtml('p', cleanAudit());
    expect(auditPassed(audit.snapshot())).toBe(true);
  });

  it('prints PASS, BLOCKED or INTERRUPTED as the verdict', () => {
    const clean = createAuditAccumulator();
    clean.recordHtml('p', cleanAudit());
    expect(formatAuditReport(clean.snapshot(), { partial: false })).toContain('AUDIT — PASS');
    expect(formatAuditReport(clean.snapshot(), { partial: true })).toContain('INTERRUPTED');

    const blocked = createAuditAccumulator();
    blocked.recordHtml('p', lossyAudit());
    const report = formatAuditReport(blocked.snapshot(), { partial: false });
    expect(report).toContain('AUDIT — BLOCKED');
    expect(report).toContain('counter decreased: img');
    expect(report).toContain('p');
  });

  it('carries the tagless count into the header so a PASS cannot hide it', () => {
    const audit = createAuditAccumulator();
    audit.recordHtml('t', { ...audited(cleanAudit()), tagless: true });
    const report = formatAuditReport(audit.snapshot(), { partial: false });
    expect(report).toContain('AUDIT — PASS');
    expect(report).toContain('NOTE: 1 html-mode page(s) contain no HTML element');
    const clean = createAuditAccumulator();
    clean.recordHtml('p', cleanAudit());
    expect(formatAuditReport(clean.snapshot(), { partial: false })).not.toContain('NOTE:');
  });

  it('never prints document content — only ids, counts and construct names', () => {
    const sentinel = 'SENTINEL_PROSE_9f3a';
    const audit = createAuditAccumulator();
    audit.recordHtml('page_x', auditPage(`<h4>${sentinel}</h4><img src="https://h.test/${sentinel}.png" alt="${sentinel}"><p>${sentinel}</p>`, workspace));
    const report = formatAuditReport(audit.snapshot(), { partial: false });
    expect(report).toContain('page_x');
    expect(report).not.toContain(sentinel);
    expect(JSON.stringify(audit.snapshot())).not.toContain(sentinel);
  });
});

describe('options', () => {
  it('defaults, and reads each flag', () => {
    expect(parseAuditArgs([])).toEqual({ limit: Number.POSITIVE_INFINITY, batchSize: 200, progressEvery: 500 });
    expect(parseAuditArgs(['--limit', '50', '--batch-size', '10', '--progress-every', '5'])).toEqual({
      limit: 50,
      batchSize: 10,
      progressEvery: 5,
    });
  });

  it('refuses a flag without a positive integer rather than silently auditing everything', () => {
    expect(() => parseAuditArgs(['--limit'])).toThrow(/--limit requires a positive integer/);
    expect(() => parseAuditArgs(['--limit', '0'])).toThrow(/--limit requires a positive integer/);
    expect(() => parseAuditArgs(['--limit', 'ten'])).toThrow(/--limit requires a positive integer/);
  });
});

/**
 * The audit runs against production with the production credential. "It only
 * reads" and "one query at a time" have to be checkable without reading the
 * whole script, so they are tests: no audit source may contain a write, and
 * the script may not fan queries out against the `max: 1` pool.
 */
describe('the audit is read-only and sequential by construction', () => {
  // Globbed, not listed: a hand-written inventory is how a file ends up
  // unscanned while the test stays green. Opting a file out has to be a
  // visible edit here.
  const libDir = 'lib/seed-audit';
  const sources = [
    'collab-seed-audit.ts',
    ...readdirSync(path.join(scriptsDir, libDir))
      .filter((entry) => entry.endsWith('.ts'))
      .map((entry) => `${libDir}/${entry}`),
  ];

  // Comments are stripped first: the script's own header explains that it never
  // runs an INSERT, and a scanner that cannot tell code from prose would either
  // fail on that sentence or force the sentence out of the file.
  const codeOf = (relative: string) =>
    readFileSync(path.join(scriptsDir, relative), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const writes = [
    /\.insert\s*\(/,
    /\.update\s*\(/,
    /\.delete\s*\(/,
    /\btransaction\s*\(/,
    /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT)\b/i,
  ];

  it.each(sources)('%s contains no write', (relative) => {
    const code = codeOf(relative);
    for (const write of writes) {
      expect(code).not.toMatch(write);
    }
  });

  it('never fans queries out against the max: 1 migration pool', () => {
    expect(codeOf('collab-seed-audit.ts')).not.toMatch(/Promise\.(all|allSettled|race|any)\s*\(/);
  });

  it('puts the session read-only at the server and checks that it took, before the first real query', () => {
    const code = codeOf('collab-seed-audit.ts');
    const enforce = code.indexOf('enforceReadOnlySession(getMigrationPool())');
    const check = code.indexOf('assertReadOnlySession(');
    const firstSelect = code.indexOf('.select(');
    expect(enforce).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(enforce);
    expect(firstSelect).toBeGreaterThan(check);
  });

  it('scans every audit module, not a list that can go stale', () => {
    expect(sources).toContain(`${libDir}/analyze.ts`);
    expect(sources).toContain(`${libDir}/report.ts`);
    expect(sources.length).toBeGreaterThanOrEqual(5);
  });

  it('strips comments before scanning, but not code that follows one', () => {
    expect(codeOf('collab-seed-audit.ts')).toContain('getMigrationDb');
  });
});
