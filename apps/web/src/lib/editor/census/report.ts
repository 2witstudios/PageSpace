import type { HtmlDocumentAnalysis } from './round-trip';
import type { MarkdownAnalysis } from './markdown';
import type { ImageSource } from './images';
import { MAGNITUDE_METRICS, type MagnitudeKey, type Magnitudes } from './magnitudes';

/**
 * Constructs the census always reports a row for, even when the count is zero:
 * every one of them was verified dropped by the live schema during Phase B
 * scoping, so a zero here is a finding ("no stored document uses it") rather
 * than a gap in the scan. Anything else the round trip loses is discovered and
 * added to the report by `droppedConstructs`, not listed here.
 *
 * `<img>` is the exception that proves the rule, and the reason the report now
 * carries an image section of its own: the editor has no image node, so its
 * zero says nothing about whether v1 needs one. A zero is a finding only when
 * the feature exists and nobody used it.
 */
export const TRACKED_HTML_CONSTRUCTS: readonly string[] = [
  '<img>',
  '<h4>',
  '<h5>',
  '<h6>',
  '<figure>',
  '<figcaption>',
  '<iframe>',
  '<details>',
  '<summary>',
  '<mark>',
  '<sup>',
  '<sub>',
  '<div>',
  'attr:data-type=taskList',
  'style:text-align',
];

/**
 * Three, because the census is read in a terminal against production data: an
 * id is a safe handle to go and look at a page deliberately, a long list is a
 * transcript of who wrote what.
 */
const MAX_EXAMPLE_PAGE_IDS = 3;

/**
 * Hosts are a long tail by nature. Ten answers "whose images are these" —
 * enough to tell one CDN from forty one-off blogs, which is the decision
 * (ingest at migration, or hotlink forever) the number is for.
 */
const MAX_REPORTED_IMAGE_HOSTS = 10;

export interface ConstructTally {
  construct: string;
  pages: number;
  examplePageIds: string[];
}

/**
 * A magnitude is the largest single instance seen anywhere, with the pages that
 * hold the top few — not a page count. See `magnitudes.ts` for why pagination
 * needs sizes where everything else here needs presence.
 */
export interface MagnitudeRow {
  metric: MagnitudeKey;
  label: string;
  value: number;
  examplePageIds: string[];
}

export interface CensusTotals {
  /** Derived in `snapshot()` from html + markdown, never counted by hand. */
  documents: number;
  html: number;
  markdown: number;
  empty: number;
  failed: number;
  /**
   * `contentMode='html'` documents that parsed to no HTML element at all:
   * markdown source under the wrong label. The first production run found
   * 3,003 of them, and they are the population that actually carries images.
   */
  taglessHtml: number;
  /** Image instances, not pages — the only count here that is not per page. */
  images: number;
  /** Documents the round trip returned with less text than they went in with. */
  textLost: number;
  /**
   * Documents that lost text while every construct the census names survived —
   * the alarm that the catalogue is missing something, and the reason the
   * report prints it next to the table.
   */
  textLostWithNoNamedConstruct: number;
}

export interface CensusSnapshot {
  totals: CensusTotals;
  htmlConstructs: ConstructTally[];
  markdownConstructs: ConstructTally[];
  /**
   * Markdown syntax found in documents labelled `contentMode='html'`. Kept
   * apart from `markdownConstructs` on purpose: merging them would make the
   * labelled-markdown numbers incomparable with the runs that came before this
   * population was scanned at all.
   */
  mislabelledMarkdownConstructs: ConstructTally[];
  /** Scheme buckets, per page. See `images.ts`. */
  imageSources: ConstructTally[];
  /** Bare hostnames, per page, top `MAX_REPORTED_IMAGE_HOSTS` only. */
  imageHosts: ConstructTally[];
  magnitudes: MagnitudeRow[];
  /** Keyed by error type rather than construct — see `recordHtml`. */
  failures: ConstructTally[];
  textLoss: ConstructTally[];
}

export interface CensusAccumulator {
  recordHtml(pageId: string, analysis: HtmlDocumentAnalysis): void;
  recordMarkdown(pageId: string, analysis: MarkdownAnalysis): void;
  /**
   * A tagless `contentMode='html'` page, read a second time as the markdown it
   * actually is. Deliberately does NOT touch the html/markdown document totals:
   * the page has already been counted once as html, and counting it twice would
   * make `documents` disagree with the row count of the table it came from.
   */
  recordMislabelledMarkdown(pageId: string, analysis: MarkdownAnalysis): void;
  recordEmpty(contentMode: 'html' | 'markdown'): void;
  snapshot(): CensusSnapshot;
}

type Tallies = Map<string, { pages: number; examplePageIds: string[] }>;
type Leaderboards = Map<MagnitudeKey, Array<{ value: number; pageId: string }>>;

function tally(tallies: Tallies, key: string, pageId: string): void {
  let entry = tallies.get(key);
  if (!entry) {
    entry = { pages: 0, examplePageIds: [] };
    tallies.set(key, entry);
  }
  entry.pages += 1;
  if (entry.examplePageIds.length < MAX_EXAMPLE_PAGE_IDS) {
    entry.examplePageIds.push(pageId);
  }
}

function rows(tallies: Tallies): ConstructTally[] {
  return [...tallies]
    .map(([construct, entry]) => ({ construct, pages: entry.pages, examplePageIds: [...entry.examplePageIds] }))
    .sort((a, b) => b.pages - a.pages || a.construct.localeCompare(b.construct));
}

export function createCensusAccumulator(): CensusAccumulator {
  const htmlTallies: Tallies = new Map(TRACKED_HTML_CONSTRUCTS.map((construct) => [construct, { pages: 0, examplePageIds: [] }]));
  const markdownTallies: Tallies = new Map();
  const mislabelledTallies: Tallies = new Map();
  const imageSourceTallies: Tallies = new Map();
  const imageHostTallies: Tallies = new Map();
  const failureTallies: Tallies = new Map();
  // Diagnostic bucket: the text-loss counters are the most alarming numbers in
  // the report and, as bare counts, the least actionable — there is no way to go
  // and look at a page that lost text. Ids only, same rule as everywhere else.
  const textLossTallies: Tallies = new Map();
  const leaderboards: Leaderboards = new Map(MAGNITUDE_METRICS.map((metric) => [metric.key, []]));
  const totals: Omit<CensusTotals, 'documents'> = {
    html: 0,
    markdown: 0,
    empty: 0,
    failed: 0,
    taglessHtml: 0,
    images: 0,
    textLost: 0,
    textLostWithNoNamedConstruct: 0,
  };

  function recordImages(pageId: string, images: readonly ImageSource[]): void {
    totals.images += images.length;
    // Per page, like every other tally: "how many documents would a decision
    // about data URIs affect" is the question, not how many tags exist.
    const buckets = new Set(images.map((image) => image.bucket));
    for (const bucket of buckets) {
      tally(imageSourceTallies, bucket, pageId);
    }
    const hosts = new Set(images.map((image) => image.host).filter((host): host is string => host !== null));
    for (const host of hosts) {
      tally(imageHostTallies, host, pageId);
    }
  }

  function recordMagnitudes(pageId: string, magnitudes: Magnitudes): void {
    for (const { key } of MAGNITUDE_METRICS) {
      const value = magnitudes[key];
      if (value <= 0) continue;

      const board = leaderboards.get(key);
      if (!board) continue;
      board.push({ value, pageId });
      board.sort((a, b) => b.value - a.value);
      if (board.length > MAX_EXAMPLE_PAGE_IDS) board.length = MAX_EXAMPLE_PAGE_IDS;
    }
  }

  return {
    recordHtml(pageId, analysis) {
      totals.html += 1;

      if (analysis.status === 'failed') {
        totals.failed += 1;
        tally(failureTallies, analysis.errorName, pageId);
        return;
      }

      if (analysis.tagless) totals.taglessHtml += 1;
      recordImages(pageId, analysis.images);
      recordMagnitudes(pageId, analysis.magnitudes);

      // A page carrying three <img> is one page for this count. The census is
      // asked how many DOCUMENTS a v1 omission would damage, not how many tags.
      // `droppedConstructs` already returns a de-duplicated list; the Set here
      // makes that a guarantee of this counter rather than of its caller.
      for (const construct of new Set(analysis.dropped)) {
        tally(htmlTallies, construct, pageId);
      }

      if (!analysis.textPreserved) {
        totals.textLost += 1;
        if (analysis.dropped.length === 0) {
          totals.textLostWithNoNamedConstruct += 1;
          tally(textLossTallies, 'text-lost:no-named-construct', pageId);
        } else {
          tally(textLossTallies, 'text-lost:with-construct', pageId);
        }
      }
    },

    recordMarkdown(pageId, analysis) {
      totals.markdown += 1;
      recordImages(pageId, analysis.images);
      recordMagnitudes(pageId, analysis.magnitudes);
      for (const construct of new Set(analysis.constructs)) {
        tally(markdownTallies, construct, pageId);
      }
    },

    recordMislabelledMarkdown(pageId, analysis) {
      recordImages(pageId, analysis.images);
      recordMagnitudes(pageId, analysis.magnitudes);
      for (const construct of new Set(analysis.constructs)) {
        tally(mislabelledTallies, construct, pageId);
      }
    },

    recordEmpty(contentMode) {
      totals.empty += 1;
      if (contentMode === 'markdown') {
        totals.markdown += 1;
      } else {
        totals.html += 1;
      }
    },

    snapshot() {
      return {
        totals: { ...totals, documents: totals.html + totals.markdown },
        htmlConstructs: rows(htmlTallies),
        markdownConstructs: rows(markdownTallies),
        mislabelledMarkdownConstructs: rows(mislabelledTallies),
        imageSources: rows(imageSourceTallies),
        imageHosts: rows(imageHostTallies).slice(0, MAX_REPORTED_IMAGE_HOSTS),
        magnitudes: MAGNITUDE_METRICS.map(({ key, label }) => {
          const board = leaderboards.get(key) ?? [];
          return {
            metric: key,
            label,
            value: board[0]?.value ?? 0,
            examplePageIds: board.map((entry) => entry.pageId),
          };
        }),
        failures: rows(failureTallies),
        textLoss: rows(textLossTallies),
      };
    },
  };
}

function table(title: string, tallies: ConstructTally[]): string[] {
  if (tallies.length === 0) {
    return [title, '  (none)', ''];
  }

  const width = Math.max(...tallies.map((row) => row.construct.length), 'CONSTRUCT'.length);
  return [
    title,
    `  ${'CONSTRUCT'.padEnd(width)}  ${'PAGES'.padStart(7)}  EXAMPLE PAGE IDS`,
    ...tallies.map(
      (row) => `  ${row.construct.padEnd(width)}  ${String(row.pages).padStart(7)}  ${row.examplePageIds.join(' ')}`,
    ),
    '',
  ];
}

function magnitudeTable(magnitudes: MagnitudeRow[]): string[] {
  const width = Math.max(...magnitudes.map((row) => row.label.length), 'LARGEST'.length);
  return [
    'magnitudes — the biggest single instance anywhere (paged layout cannot split a block)',
    `  ${'LARGEST'.padEnd(width)}  ${'VALUE'.padStart(7)}  EXAMPLE PAGE IDS`,
    ...magnitudes.map(
      (row) => `  ${row.label.padEnd(width)}  ${String(row.value).padStart(7)}  ${row.examplePageIds.join(' ')}`,
    ),
    '',
  ];
}

export interface ReportOptions {
  partial: boolean;
  /**
   * Pages with `isPaginated` set, straight from the database. Nothing in the UI
   * writes that column today — `DocumentView` hardcodes `isPaginated={false}` —
   * so the count answers whether the switch is genuinely unused or whether the
   * API has been setting it all along.
   *
   * A whole-table aggregate, and labelled as one in the report: every other
   * total counts what the scan reached, and under `--limit` or a Ctrl-C the two
   * scopes differ. Scoping it to the scanned batch would need the ids, which
   * would mean holding every id in memory to answer a question about a boolean.
   */
  paginatedPages?: number;
}

export function formatCensusReport(snapshot: CensusSnapshot, { partial, paginatedPages }: ReportOptions): string {
  const { totals } = snapshot;
  const lines = [
    '',
    partial ? 'COLLAB CONTENT CENSUS — INTERRUPTED, PARTIAL COUNTS' : 'COLLAB CONTENT CENSUS',
    '',
    `  DOCUMENT pages scanned          ${totals.documents}`,
    `  contentMode=html                ${totals.html}`,
    `  contentMode=markdown            ${totals.markdown}`,
    `  empty documents                 ${totals.empty}`,
    `  html-mode with no HTML at all   ${totals.taglessHtml}`,
    `  round trip failed               ${totals.failed}`,
    `  text lost in the round trip     ${totals.textLost}`,
    `  text lost, no named construct   ${totals.textLostWithNoNamedConstruct}`,
    `  images found (instances)        ${totals.images}`,
    ...(paginatedPages === undefined
      ? []
      : [`  isPaginated set (whole table)   ${paginatedPages}`]),
    '',
    ...table('HTML documents — constructs the schema drops', snapshot.htmlConstructs),
    ...table('markdown documents — source syntax the schema has no node for', snapshot.markdownConstructs),
    ...table(
      'html-mode documents that are really markdown — source syntax the schema has no node for',
      snapshot.mislabelledMarkdownConstructs,
    ),
    ...table('where images point (scheme only — never a URL)', snapshot.imageSources),
    ...table(`external image hosts (top ${MAX_REPORTED_IMAGE_HOSTS}, hostname only)`, snapshot.imageHosts),
    ...magnitudeTable(snapshot.magnitudes),
  ];

  if (snapshot.textLoss.length > 0) {
    lines.push(
      '',
      'text loss — example pages (ids only; go and read these)',
      ...snapshot.textLoss.map((row) => `  ${row.construct}  ${row.pages}  ${row.examplePageIds.join(' ')}`),
    );
  }

  if (snapshot.failures.length > 0) {
    lines.push(
      'Documents the round trip could not process (error type only — never content)',
      ...snapshot.failures.map((row) => `  ${row.construct}  ${row.pages}  ${row.examplePageIds.join(' ')}`),
      '',
    );
  }

  return lines.join('\n');
}
