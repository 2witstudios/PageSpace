import { describe, it, expect } from 'vitest';
import { createCensusAccumulator, formatCensusReport, TRACKED_HTML_CONSTRUCTS } from '../report';
import { emptyMagnitudes, type Magnitudes } from '../magnitudes';
import type { HtmlDocumentAnalysis } from '../round-trip';
import type { MarkdownAnalysis } from '../markdown';
import type { ImageSource, ImageSourceBucket } from '../images';

/**
 * The fields these tests are not about, filled in once. Spelling out
 * `tagless`/`images`/`magnitudes` at all twelve call sites would bury the one
 * field each test is actually asserting on.
 */
const analysed = (
  overrides: Partial<Extract<HtmlDocumentAnalysis, { status: 'analysed' }>> = {},
): HtmlDocumentAnalysis => ({
  status: 'analysed',
  dropped: [],
  textPreserved: true,
  tagless: false,
  images: [],
  magnitudes: emptyMagnitudes(),
  ...overrides,
});

const markdown = (
  constructs: string[] = [],
  images: ImageSource[] = [],
  magnitudes: Magnitudes = emptyMagnitudes(),
): MarkdownAnalysis => ({ constructs, images, magnitudes });

describe('createCensusAccumulator', () => {
  it('counts pages per construct and keeps at most three example page ids', () => {
    const accumulator = createCensusAccumulator();
    for (const pageId of ['p1', 'p2', 'p3', 'p4']) {
      accumulator.recordHtml(pageId, analysed({ dropped: ['<img>'], textPreserved: true }));
    }

    const [tally] = accumulator.snapshot().htmlConstructs.filter((row) => row.construct === '<img>');
    expect(tally.pages).toBe(4);
    expect(tally.examplePageIds).toEqual(['p1', 'p2', 'p3']);
  });

  it('counts a construct once per page, however many times the page carries it', () => {
    const accumulator = createCensusAccumulator();
    accumulator.recordHtml('p1', analysed({ dropped: ['<img>', '<img>'], textPreserved: true }));
    const [tally] = accumulator.snapshot().htmlConstructs.filter((row) => row.construct === '<img>');
    expect(tally.pages).toBe(1);
    expect(tally.examplePageIds).toEqual(['p1']);
  });

  it('sorts constructs by page count descending, then by name', () => {
    const accumulator = createCensusAccumulator();
    accumulator.recordHtml('p1', analysed({ dropped: ['<mark>', '<sup>', '<figure>'], textPreserved: true }));
    accumulator.recordHtml('p2', analysed({ dropped: ['<sup>'], textPreserved: true }));

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
    accumulator.recordMarkdown('p1', markdown(['md:image']));
    accumulator.recordHtml('p2', analysed({ dropped: ['<img>'], textPreserved: true }));

    const snapshot = accumulator.snapshot();
    expect(snapshot.markdownConstructs.map((row) => row.construct)).toEqual(['md:image']);
    expect(snapshot.htmlConstructs.filter((row) => row.pages > 0).map((row) => row.construct)).toEqual(['<img>']);
    expect(snapshot.totals).toMatchObject({ documents: 2, html: 1, markdown: 1 });
  });

  it('counts text loss, and separately the text loss no named construct explains', () => {
    const accumulator = createCensusAccumulator();
    accumulator.recordHtml('p1', analysed({ dropped: [], textPreserved: false }));
    accumulator.recordHtml('p2', analysed({ dropped: [], textPreserved: true }));
    // A page that lost text AND a construct the census already names is counted
    // as text loss but not as an alarm: the alarm exists to say "the catalogue
    // is missing something", and explained losses would drown it out.
    accumulator.recordHtml('p3', analysed({ dropped: ['<img>'], textPreserved: false }));
    expect(accumulator.snapshot().totals).toMatchObject({ textLost: 2, textLostWithNoNamedConstruct: 1 });
  });

  it('tallies failures by error type with their own examples', () => {
    const accumulator = createCensusAccumulator();
    accumulator.recordHtml('p1', { status: 'failed', errorName: 'RangeError' });
    accumulator.recordHtml('p2', { status: 'failed', errorName: 'RangeError' });

    const snapshot = accumulator.snapshot();
    expect(snapshot.failures).toEqual([{ construct: 'RangeError', pages: 2, examplePageIds: ['p1', 'p2'] }]);
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
    accumulator.recordHtml('page-one', analysed({ dropped: ['<img>'], textPreserved: true }));
    accumulator.recordMarkdown('page-two', markdown(['md:task-list']));
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

const image = (bucket: ImageSourceBucket, host: string | null = null): ImageSource => ({ bucket, host });

describe('the mislabelled markdown tally', () => {
  it('keeps markdown found in html-mode pages apart from the pages that carry the label', () => {
    // Merging them would make every labelled-markdown number incomparable with
    // the run that produced them, which is the one number the re-run has to
    // hold still.
    const accumulator = createCensusAccumulator();
    accumulator.recordMarkdown('labelled', markdown(['md:image']));
    accumulator.recordMislabelledMarkdown('mislabelled', markdown(['md:task-list']));

    const snapshot = accumulator.snapshot();
    expect(snapshot.markdownConstructs.map((row) => row.construct)).toEqual(['md:image']);
    expect(snapshot.mislabelledMarkdownConstructs.map((row) => row.construct)).toEqual(['md:task-list']);
  });

  it('does not count the same page twice, because it was already counted as html', () => {
    const accumulator = createCensusAccumulator();
    accumulator.recordHtml('p1', analysed({ tagless: true }));
    accumulator.recordMislabelledMarkdown('p1', markdown(['md:image']));

    expect(accumulator.snapshot().totals).toMatchObject({ documents: 1, html: 1, markdown: 0, taglessHtml: 1 });
  });

  it('counts a tagless html page whether or not anything routed it onward', () => {
    const accumulator = createCensusAccumulator();
    accumulator.recordHtml('p1', analysed({ tagless: true }));
    accumulator.recordHtml('p2', analysed({ tagless: false }));
    expect(accumulator.snapshot().totals.taglessHtml).toBe(1);
  });
});

describe('the image tallies', () => {
  it('counts a page once per bucket, and every image in the instance total', () => {
    const accumulator = createCensusAccumulator();
    accumulator.recordMarkdown('p1', markdown([], [image('img-src:data-uri'), image('img-src:data-uri')]));

    const snapshot = accumulator.snapshot();
    expect(snapshot.imageSources).toEqual([
      { construct: 'img-src:data-uri', pages: 1, examplePageIds: ['p1'] },
    ]);
    expect(snapshot.totals.images).toBe(2);
  });

  it('tallies images from html, markdown and mislabelled pages into one section', () => {
    const accumulator = createCensusAccumulator();
    accumulator.recordHtml('p1', analysed({ images: [image('img-src:relative')] }));
    accumulator.recordMarkdown('p2', markdown([], [image('img-src:relative')]));
    accumulator.recordMislabelledMarkdown('p3', markdown([], [image('img-src:relative')]));

    expect(accumulator.snapshot().imageSources).toEqual([
      { construct: 'img-src:relative', pages: 3, examplePageIds: ['p1', 'p2', 'p3'] },
    ]);
  });

  it('reports at most ten hosts, because the tail is a list of one-off blogs', () => {
    const accumulator = createCensusAccumulator();
    for (let index = 0; index < 14; index += 1) {
      accumulator.recordMarkdown(`p${index}`, markdown([], [image('img-src:external-https', `host${index}.test`)]));
    }
    expect(accumulator.snapshot().imageHosts).toHaveLength(10);
  });

  it('does not invent a host row for an image that has no host', () => {
    const accumulator = createCensusAccumulator();
    accumulator.recordMarkdown('p1', markdown([], [image('img-src:data-uri', null)]));
    expect(accumulator.snapshot().imageHosts).toEqual([]);
  });
});

describe('the magnitudes', () => {
  const withImages = (count: number) => ({ ...emptyMagnitudes(), images: count });

  it('reports the largest single instance and the pages holding the top few', () => {
    const accumulator = createCensusAccumulator();
    accumulator.recordMarkdown('small', markdown([], [], withImages(1)));
    accumulator.recordMarkdown('largest', markdown([], [], withImages(40)));
    accumulator.recordMarkdown('second', markdown([], [], withImages(9)));

    const [images] = accumulator.snapshot().magnitudes.filter((row) => row.metric === 'images');
    expect(images.value).toBe(40);
    expect(images.examplePageIds).toEqual(['largest', 'second', 'small']);
  });

  it('keeps three examples however many pages are measured', () => {
    const accumulator = createCensusAccumulator();
    for (let index = 0; index < 8; index += 1) {
      accumulator.recordMarkdown(`p${index}`, markdown([], [], withImages(index + 1)));
    }
    const [images] = accumulator.snapshot().magnitudes.filter((row) => row.metric === 'images');
    expect(images.examplePageIds).toEqual(['p7', 'p6', 'p5']);
  });

  it('reports a row per metric even when nothing in the corpus has one', () => {
    const rows = createCensusAccumulator().snapshot().magnitudes;
    expect(rows.map((row) => row.metric)).toContain('tableRows');
    expect(rows.every((row) => row.value === 0 && row.examplePageIds.length === 0)).toBe(true);
  });
});

describe('formatCensusReport, the new sections', () => {
  const snapshot = () => {
    const accumulator = createCensusAccumulator();
    accumulator.recordHtml('page-one', analysed({ tagless: true }));
    accumulator.recordMislabelledMarkdown(
      'page-one',
      markdown(['md:image'], [image('img-src:external-https', 'cdn.example.test')], {
        ...emptyMagnitudes(),
        images: 3,
      }),
    );
    return accumulator.snapshot();
  };

  it('prints the mislabelled table, the image sections and the magnitudes', () => {
    const report = formatCensusReport(snapshot(), { partial: false });
    expect(report).toContain('really markdown');
    expect(report).toContain('md:image');
    expect(report).toContain('img-src:external-https');
    expect(report).toContain('cdn.example.test');
    expect(report).toContain('images in one document');
    expect(report).toContain('html-mode with no HTML at all');
  });

  it('prints the isPaginated count only when the run asked the database for it', () => {
    expect(formatCensusReport(snapshot(), { partial: false, paginatedPages: 7 })).toContain(
      'isPaginated set (whole table)   7',
    );
    expect(formatCensusReport(snapshot(), { partial: false })).not.toContain('isPaginated');
  });
});
