import type { HtmlDocumentAnalysis } from './round-trip';

/**
 * Constructs the census always reports a row for, even when the count is zero:
 * every one of them was verified dropped by the live schema during Phase B
 * scoping, so a zero here is a finding ("no stored document uses it") rather
 * than a gap in the scan. Anything else the round trip loses is discovered and
 * added to the report by `droppedConstructs`, not listed here.
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

export interface ConstructTally {
  construct: string;
  pages: number;
  examplePageIds: string[];
}

export interface FailureTally {
  errorName: string;
  pages: number;
  examplePageIds: string[];
}

export interface CensusTotals {
  documents: number;
  html: number;
  markdown: number;
  empty: number;
  failed: number;
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
  failures: FailureTally[];
}

export interface CensusAccumulator {
  recordHtml(pageId: string, analysis: HtmlDocumentAnalysis): void;
  recordMarkdown(pageId: string, constructs: readonly string[]): void;
  recordEmpty(contentMode: 'html' | 'markdown'): void;
  snapshot(): CensusSnapshot;
}

type Tallies = Map<string, { pages: number; examplePageIds: string[] }>;

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
  const failureTallies: Tallies = new Map();
  const totals: CensusTotals = {
    documents: 0,
    html: 0,
    markdown: 0,
    empty: 0,
    failed: 0,
    textLost: 0,
    textLostWithNoNamedConstruct: 0,
  };

  return {
    recordHtml(pageId, analysis) {
      totals.documents += 1;
      totals.html += 1;

      if (analysis.status === 'failed') {
        totals.failed += 1;
        tally(failureTallies, analysis.errorName, pageId);
        return;
      }

      // A page carrying three <img> is one page for this count. The census is
      // asked how many DOCUMENTS a v1 omission would damage, not how many tags.
      for (const construct of new Set(analysis.dropped)) {
        tally(htmlTallies, construct, pageId);
      }

      if (!analysis.textPreserved) {
        totals.textLost += 1;
        if (analysis.dropped.length === 0) {
          totals.textLostWithNoNamedConstruct += 1;
        }
      }
    },

    recordMarkdown(pageId, constructs) {
      totals.documents += 1;
      totals.markdown += 1;
      for (const construct of new Set(constructs)) {
        tally(markdownTallies, construct, pageId);
      }
    },

    recordEmpty(contentMode) {
      totals.documents += 1;
      totals.empty += 1;
      if (contentMode === 'markdown') {
        totals.markdown += 1;
      } else {
        totals.html += 1;
      }
    },

    snapshot() {
      return {
        totals: { ...totals },
        htmlConstructs: rows(htmlTallies),
        markdownConstructs: rows(markdownTallies),
        failures: rows(failureTallies).map(({ construct, pages, examplePageIds }) => ({
          errorName: construct,
          pages,
          examplePageIds,
        })),
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

export function formatCensusReport(snapshot: CensusSnapshot, { partial }: { partial: boolean }): string {
  const { totals } = snapshot;
  const lines = [
    '',
    partial ? 'COLLAB CONTENT CENSUS — INTERRUPTED, PARTIAL COUNTS' : 'COLLAB CONTENT CENSUS',
    '',
    `  DOCUMENT pages scanned          ${totals.documents}`,
    `  contentMode=html                ${totals.html}`,
    `  contentMode=markdown            ${totals.markdown}`,
    `  empty documents                 ${totals.empty}`,
    `  round trip failed               ${totals.failed}`,
    `  text lost in the round trip     ${totals.textLost}`,
    `  text lost, no named construct   ${totals.textLostWithNoNamedConstruct}`,
    '',
    ...table('HTML documents — constructs the schema drops', snapshot.htmlConstructs),
    ...table('markdown documents — source syntax the schema has no node for', snapshot.markdownConstructs),
  ];

  if (snapshot.failures.length > 0) {
    lines.push(
      'Documents the round trip could not process (error type only — never content)',
      ...snapshot.failures.map((row) => `  ${row.errorName}  ${row.pages}  ${row.examplePageIds.join(' ')}`),
      '',
    );
  }

  return lines.join('\n');
}
