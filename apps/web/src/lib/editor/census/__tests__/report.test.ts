import { describe, it, expect } from 'vitest';
import { createCensusAccumulator, formatCensusReport, TRACKED_HTML_CONSTRUCTS } from '../report';

describe('createCensusAccumulator', () => {
  it('counts pages per construct and keeps at most three example page ids', () => {
    const accumulator = createCensusAccumulator();
    for (const pageId of ['p1', 'p2', 'p3', 'p4']) {
      accumulator.recordHtml(pageId, { status: 'analysed', dropped: ['<img>'], textPreserved: true });
    }

    const [tally] = accumulator.snapshot().htmlConstructs.filter((row) => row.construct === '<img>');
    expect(tally.pages).toBe(4);
    expect(tally.examplePageIds).toEqual(['p1', 'p2', 'p3']);
  });

  it('counts a construct once per page, however many times the page carries it', () => {
    const accumulator = createCensusAccumulator();
    accumulator.recordHtml('p1', { status: 'analysed', dropped: ['<img>', '<img>'], textPreserved: true });
    const [tally] = accumulator.snapshot().htmlConstructs.filter((row) => row.construct === '<img>');
    expect(tally.pages).toBe(1);
    expect(tally.examplePageIds).toEqual(['p1']);
  });

  it('sorts constructs by page count descending, then by name', () => {
    const accumulator = createCensusAccumulator();
    accumulator.recordHtml('p1', { status: 'analysed', dropped: ['<mark>', '<sup>', '<figure>'], textPreserved: true });
    accumulator.recordHtml('p2', { status: 'analysed', dropped: ['<sup>'], textPreserved: true });

    const found = accumulator.snapshot().htmlConstructs.filter((row) => row.pages > 0);
    expect(found.map((row) => row.construct)).toEqual(['<sup>', '<figure>', '<mark>']);
  });

  it('lists every tracked construct even when no page has it, so a zero is a result', () => {
    // Spelled out rather than iterated over TRACKED_HTML_CONSTRUCTS: this is
    // the Phase B minimum ("all verified dropped by the current schema"), and
    // a test that reads the list it is checking would pass an empty one.
    const required = [
      '<img>', '<h4>', '<h5>', '<h6>', '<figure>', '<figcaption>', '<iframe>',
      '<details>', '<summary>', '<mark>', '<sup>', '<sub>', '<div>',
      'attr:data-type=taskList', 'style:text-align',
    ];
    expect([...TRACKED_HTML_CONSTRUCTS].sort()).toEqual([...required].sort());

    const constructs = createCensusAccumulator().snapshot().htmlConstructs.map((row) => row.construct);
    for (const tracked of required) {
      expect(constructs).toContain(tracked);
    }
  });

  it('keeps markdown documents in their own tally', () => {
    const accumulator = createCensusAccumulator();
    accumulator.recordMarkdown('p1', ['md:image']);
    accumulator.recordHtml('p2', { status: 'analysed', dropped: ['<img>'], textPreserved: true });

    const snapshot = accumulator.snapshot();
    expect(snapshot.markdownConstructs.map((row) => row.construct)).toEqual(['md:image']);
    expect(snapshot.htmlConstructs.filter((row) => row.pages > 0).map((row) => row.construct)).toEqual(['<img>']);
    expect(snapshot.totals).toMatchObject({ documents: 2, html: 1, markdown: 1 });
  });

  it('counts text loss, and separately the text loss no named construct explains', () => {
    const accumulator = createCensusAccumulator();
    accumulator.recordHtml('p1', { status: 'analysed', dropped: [], textPreserved: false });
    accumulator.recordHtml('p2', { status: 'analysed', dropped: [], textPreserved: true });
    // A page that lost text AND a construct the census already names is counted
    // as text loss but not as an alarm: the alarm exists to say "the catalogue
    // is missing something", and explained losses would drown it out.
    accumulator.recordHtml('p3', { status: 'analysed', dropped: ['<img>'], textPreserved: false });
    expect(accumulator.snapshot().totals).toMatchObject({ textLost: 2, textLostWithNoNamedConstruct: 1 });
  });

  it('tallies failures by error type with their own examples', () => {
    const accumulator = createCensusAccumulator();
    accumulator.recordHtml('p1', { status: 'failed', errorName: 'RangeError' });
    accumulator.recordHtml('p2', { status: 'failed', errorName: 'RangeError' });

    const snapshot = accumulator.snapshot();
    expect(snapshot.failures).toEqual([{ errorName: 'RangeError', pages: 2, examplePageIds: ['p1', 'p2'] }]);
    expect(snapshot.totals.failed).toBe(2);
  });

  it('counts empty documents without attributing a construct to them', () => {
    const accumulator = createCensusAccumulator();
    accumulator.recordEmpty('html');
    accumulator.recordEmpty('markdown');
    expect(accumulator.snapshot().totals).toMatchObject({ documents: 2, empty: 2, html: 1, markdown: 1 });
  });
});

describe('formatCensusReport', () => {
  const snapshotWith = () => {
    const accumulator = createCensusAccumulator();
    accumulator.recordHtml('page-one', { status: 'analysed', dropped: ['<img>'], textPreserved: true });
    accumulator.recordMarkdown('page-two', ['md:task-list']);
    return accumulator.snapshot();
  };

  it('prints construct, page count and example ids', () => {
    const report = formatCensusReport(snapshotWith(), { partial: false });
    expect(report).toContain('<img>');
    expect(report).toContain('page-one');
    expect(report).toContain('md:task-list');
    expect(report).toContain('page-two');
  });

  it('says so when the run was interrupted, so a partial count is never read as final', () => {
    expect(formatCensusReport(snapshotWith(), { partial: true })).toContain('INTERRUPTED');
    expect(formatCensusReport(snapshotWith(), { partial: false })).not.toContain('INTERRUPTED');
  });
});
