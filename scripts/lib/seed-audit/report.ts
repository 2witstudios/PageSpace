import { contentFreeKey } from '@pagespace/editor/seed-fidelity';
import { UNESCAPED_ANGLE_BRACKET_KEY } from '@pagespace/editor/html-element-names';
import { isLossy, type ChainResult, type PageAudit } from './analyze';

/**
 * Tallies and the printed report.
 *
 * Counts, never rates — the three criteria are hard blockers, and "0.4%
 * lossy" is exactly the framing the leaf ruled out. Every table carries
 * example page ids because a bare count is undiagnosable: an id is a handle
 * someone holding the credential can go and look at; an excerpt would be
 * user content in a terminal scrollback, so there are none anywhere here.
 */

/**
 * Three, as in the census: enough to go and look at a page deliberately, few
 * enough that the report is not a transcript of who wrote what.
 */
const MAX_EXAMPLE_PAGE_IDS = 3;

export interface TallyRow {
  key: string;
  pages: number;
  examplePageIds: string[];
}

/** The three criteria plus their conjunction, for one chain. */
export interface CriteriaTotals {
  unstable: number;
  counterDecreased: number;
  textLost: number;
  /** Pages failing ANY of the three — the number that has to be zero. */
  lossy: number;
  /** Diagnostic: whitespace-only text differences (not a criterion). */
  whitespaceOnlyTextChange: number;
}

export interface ChainTallies {
  totals: CriteriaTotals;
  /** Per-criterion example pages: `unstable`, `text-lost`, and one row per counter that decreased. */
  criteriaFailures: TallyRow[];
  /**
   * Example pages for the whitespace-only diagnostic. It is not a criterion,
   * so it has no row in `criteriaFailures` — but a bare count is
   * undiagnosable, and every other number in this report can be gone and
   * looked at.
   */
  whitespaceOnlyExamples: string[];
  /** Presence-based construct drops, tag-qualified (`el:img`, `attr:p@style:text-align`). */
  droppedConstructs: TallyRow[];
  /** The same drops, keyed the way the content census keys them, for a direct comparison. */
  droppedConstructsCensusKeyed: TallyRow[];
  /** Constructs gained outside the cosmetic allowlist. */
  unexpectedAdditions: TallyRow[];
}

export interface AuditTotals {
  /** Every DOCUMENT row the scan reached. */
  documents: number;
  /** `contentMode='html'` rows that were taken through the chains. */
  audited: number;
  /** `contentMode='markdown'` rows — markdown source, not seedable through this path (Phase K). */
  markdownMode: number;
  empty: number;
  /** Audited pages with no HTML element at all — markdown/plain text under an html label. */
  tagless: number;
  failed: number;
  /** Pages whose two projections differ byte-for-byte — `y-prosemirror`'s doing. */
  divergent: number;
}

export interface GateAgreement {
  /** Gate refuses and the seed chain is lossy — both right. */
  bothLossy: number;
  /** Gate ACCEPTS a page the seed chain shows lossy — Phase E would seed it. */
  gateBlindSpot: number;
  /** Gate refuses a page the seed chain shows clean — over-strict, not dangerous. */
  gateStricter: number;
  bothClean: number;
}

export interface AuditSnapshot {
  totals: AuditTotals;
  seed: ChainTallies;
  census: ChainTallies;
  divergence: {
    /** `y-prosemirror changed <counter>` / `text changed` / `lost <construct>` / `gained <construct>`. */
    rows: TallyRow[];
  };
  gate: {
    agreement: GateAgreement;
    /** Example pages per agreement cell — the blind-spot ids are the ones to read first. */
    agreementRows: TallyRow[];
    reasons: TallyRow[];
  };
  failures: TallyRow[];
  taglessPages: TallyRow[];
}

export interface AuditAccumulator {
  recordHtml(pageId: string, audit: PageAudit): void;
  recordMarkdownMode(pageId: string): void;
  recordEmpty(): void;
  snapshot(): AuditSnapshot;
}

type Tallies = Map<string, { pages: number; examplePageIds: string[] }>;

/** Counts one more page under `key`, keeping at most `MAX_EXAMPLE_PAGE_IDS` ids as examples. */
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

/** A tally map as report rows, most pages first and ties broken by key so runs are comparable. */
function rows(tallies: Tallies): TallyRow[] {
  return [...tallies]
    .map(([key, entry]) => ({ key, pages: entry.pages, examplePageIds: [...entry.examplePageIds] }))
    .sort((a, b) => b.pages - a.pages || a.key.localeCompare(b.key));
}

/**
 * A tag-qualified seed-fidelity key, re-keyed the way
 * `apps/web/src/lib/editor/census/constructs.ts` keys the same construct:
 * `el:img` → `<img>`; `attr:p@style:text-align` → `style:text-align`;
 * `attr:ul@data-type=taskList` → `attr:data-type=taskList` (`data-type` is
 * the census's one value-bearing attribute); every other attribute →
 * `attr:<name>`, presence only. Applied AFTER `contentFreeKey`, so the value
 * has already been validated against the schema's enumeration. Two audit keys can fold into one census key
 * (`h2@style:text-align` and `p@style:text-align`); the census counted that
 * page once, and so does the fold.
 */
export function censusKeyOf(key: string): string {
  const element = /^el:(.+)$/u.exec(key);
  if (element) return `<${element[1]}>`;
  const attribute = /^attr:[^@]+@(.+)$/u.exec(key);
  // Fail closed, for the same reason `contentFreeKey` does: a key this cannot
  // decompose is one it cannot vouch for. This branch is LIVE, not defensive —
  // every key arriving here has already been folded, and a folded key is often
  // the marker itself, which is neither an `el:` nor an `attr:` key. Returning
  // the marker unchanged is the right answer for it and the safe answer for
  // anything else.
  if (!attribute) return UNESCAPED_ANGLE_BRACKET_KEY;
  const rest = attribute[1];
  if (rest.startsWith('style:')) return rest;
  if (rest.startsWith('data-type=')) return `attr:${rest}`;
  return `attr:${rest.split('=')[0]}`;
}

/** The per-chain half of the accumulator: one of these for the seed chain, one for the census chain. */
function createChainTallies() {
  const criteria: Tallies = new Map();
  const whitespaceOnly: Tallies = new Map();
  const dropped: Tallies = new Map();
  const droppedCensus: Tallies = new Map();
  const additions: Tallies = new Map();
  const totals: CriteriaTotals = {
    unstable: 0,
    counterDecreased: 0,
    textLost: 0,
    lossy: 0,
    whitespaceOnlyTextChange: 0,
  };

  return {
    record(pageId: string, verdict: ChainResult) {
      if (!verdict.stable) {
        totals.unstable += 1;
        tally(criteria, 'unstable', pageId);
      }
      if (verdict.counterDecreases.length > 0) {
        totals.counterDecreased += 1;
        for (const key of verdict.counterDecreases) tally(criteria, `counter decreased: ${key}`, pageId);
      }
      if (!verdict.textPreserved) {
        totals.textLost += 1;
        tally(criteria, 'text-lost', pageId);
      }
      if (isLossy(verdict)) totals.lossy += 1;
      if (verdict.whitespaceOnlyTextChange) {
        totals.whitespaceOnlyTextChange += 1;
        tally(whitespaceOnly, 'spacing', pageId);
      }

      // Folded to content-free form; two keys can fold into one, and a page
      // counts once per folded key, hence the Sets.
      for (const key of new Set(verdict.droppedConstructs.map(contentFreeKey))) tally(dropped, key, pageId);
      for (const key of new Set(verdict.droppedConstructs.map((raw) => censusKeyOf(contentFreeKey(raw))))) {
        tally(droppedCensus, key, pageId);
      }
      for (const key of new Set(verdict.unexpectedAdditions.map(contentFreeKey))) tally(additions, key, pageId);
    },
    snapshot(): ChainTallies {
      return {
        totals: { ...totals },
        criteriaFailures: rows(criteria),
        whitespaceOnlyExamples: whitespaceOnly.get('spacing')?.examplePageIds ?? [],
        droppedConstructs: rows(dropped),
        droppedConstructsCensusKeyed: rows(droppedCensus),
        unexpectedAdditions: rows(additions),
      };
    },
  };
}

/** Collects every page's verdict into the one snapshot the report is formatted from. */
export function createAuditAccumulator(): AuditAccumulator {
  const seed = createChainTallies();
  const census = createChainTallies();
  const divergence: Tallies = new Map();
  const gateReasons: Tallies = new Map();
  // One tally per cell; the `agreement` counts are derived from it in
  // `snapshot()` rather than kept as a second counter that could disagree.
  const agreementRows: Tallies = new Map();
  const failures: Tallies = new Map();
  const tagless: Tallies = new Map();
  const totals: AuditTotals = {
    documents: 0,
    audited: 0,
    markdownMode: 0,
    empty: 0,
    tagless: 0,
    failed: 0,
    divergent: 0,
  };

  return {
    recordHtml(pageId, audit) {
      totals.documents += 1;
      totals.audited += 1;

      if (audit.status === 'failed') {
        totals.failed += 1;
        tally(failures, `${audit.stage}: ${audit.errorName}`, pageId);
        return;
      }

      if (audit.tagless) {
        totals.tagless += 1;
        tally(tagless, 'no HTML element', pageId);
      }

      seed.record(pageId, audit.seed);
      census.record(pageId, audit.census);

      if (audit.divergence) {
        totals.divergent += 1;
        for (const key of audit.divergence.counterChanges) tally(divergence, `counter changed: ${key}`, pageId);
        if (audit.divergence.textChanged) tally(divergence, 'text changed', pageId);
        for (const key of new Set(audit.divergence.constructsLost.map(contentFreeKey))) {
          tally(divergence, `lost: ${key}`, pageId);
        }
        for (const key of new Set(audit.divergence.constructsGained.map(contentFreeKey))) {
          tally(divergence, `gained: ${key}`, pageId);
        }
        if (
          audit.divergence.counterChanges.length === 0 &&
          !audit.divergence.textChanged &&
          audit.divergence.constructsLost.length === 0 &&
          audit.divergence.constructsGained.length === 0
        ) {
          // Bytes differ, but nothing this audit measures does — attribute
          // order, quoting, or whitespace between blocks. Still divergence;
          // still named, so it cannot hide inside a zero.
          tally(divergence, 'bytes only (no measured construct, counter or text)', pageId);
        }
      }

      const gateRefuses = audit.gateReasons.length > 0;
      const seedLossy = isLossy(audit.seed);
      const cell: keyof GateAgreement = gateRefuses
        ? seedLossy
          ? 'bothLossy'
          : 'gateStricter'
        : seedLossy
          ? 'gateBlindSpot'
          : 'bothClean';
      tally(agreementRows, cell, pageId);
      for (const reason of new Set(audit.gateReasons)) tally(gateReasons, reason, pageId);
    },

    recordMarkdownMode() {
      totals.documents += 1;
      totals.markdownMode += 1;
    },

    recordEmpty() {
      totals.documents += 1;
      totals.empty += 1;
    },

    snapshot() {
      return {
        totals: { ...totals },
        seed: seed.snapshot(),
        census: census.snapshot(),
        divergence: { rows: rows(divergence) },
        gate: {
          agreement: {
            bothLossy: agreementRows.get('bothLossy')?.pages ?? 0,
            gateBlindSpot: agreementRows.get('gateBlindSpot')?.pages ?? 0,
            gateStricter: agreementRows.get('gateStricter')?.pages ?? 0,
            bothClean: agreementRows.get('bothClean')?.pages ?? 0,
          },
          // Example ids for the three cells worth reading; `bothClean` is the
          // corpus and its ids say nothing.
          agreementRows: rows(agreementRows).filter((row) => row.key !== 'bothClean'),
          reasons: rows(gateReasons),
        },
        failures: rows(failures),
        taglessPages: rows(tagless),
      };
    },
  };
}

/** The run passes only when every hard blocker is zero on the SEED chain and nothing failed to process. */
export function auditPassed(snapshot: AuditSnapshot): boolean {
  return snapshot.seed.totals.lossy === 0 && snapshot.totals.failed === 0;
}

/** One padded report table; `(none)` rather than an empty block, so a zero is visibly a measurement. */
function table(title: string, tallies: TallyRow[], header = 'CONSTRUCT'): string[] {
  if (tallies.length === 0) {
    return [title, '  (none)', ''];
  }
  const width = Math.max(...tallies.map((row) => row.key.length), header.length);
  return [
    title,
    `  ${header.padEnd(width)}  ${'PAGES'.padStart(7)}  EXAMPLE PAGE IDS`,
    ...tallies.map(
      (row) => `  ${row.key.padEnd(width)}  ${String(row.pages).padStart(7)}  ${row.examplePageIds.join(' ')}`,
    ),
    '',
  ];
}

/** The three criteria and their conjunction for one chain, in the same shape for both. */
function criteriaBlock(title: string, chain: ChainTallies): string[] {
  const { totals } = chain;
  return [
    title,
    `  1. stability      h1 == render(parse(h1))      pages failing  ${totals.unstable}`,
    `  2. content loss   any counter decreased        pages failing  ${totals.counterDecreased}`,
    `  3. text           visible characters changed   pages failing  ${totals.textLost}`,
    `  LOSSY (any of the three)                                      ${totals.lossy}`,
    `  spacing between words changed (diagnostic, not a criterion)   ${totals.whitespaceOnlyTextChange}` +
      (chain.whitespaceOnlyExamples.length > 0 ? `  e.g. ${chain.whitespaceOnlyExamples.join(' ')}` : ''),
    '',
  ];
}

export interface ReportOptions {
  partial: boolean;
}

/** The whole report as text: verdict, totals, both chains' criteria, then every diagnostic table. */
export function formatAuditReport(snapshot: AuditSnapshot, { partial }: ReportOptions): string {
  const { totals, gate } = snapshot;
  const verdict = partial ? 'INTERRUPTED — PARTIAL, NOT A VERDICT' : auditPassed(snapshot) ? 'PASS' : 'BLOCKED';
  const lines = [
    '',
    `COLLAB SEED FIDELITY AUDIT — ${verdict}`,
    // Not a criterion — a page with no HTML element passes all three
    // trivially — but not something a PASS may hide either: Phase E must
    // refuse these regardless of what this audit says about the rest.
    ...(totals.tagless > 0
      ? [`  NOTE: ${totals.tagless} html-mode page(s) contain no HTML element (markdown or plain text under an html label). Phase E must refuse to seed them regardless of this verdict.`]
      : []),
    '',
    `  DOCUMENT pages scanned                       ${totals.documents}`,
    `  html-mode, audited through both chains       ${totals.audited}`,
    `  markdown-mode, skipped (Phase K, not HTML)   ${totals.markdownMode}`,
    `  empty                                        ${totals.empty}`,
    `  html-mode with no HTML element (refuse!)     ${totals.tagless}`,
    `  could not be processed                       ${totals.failed}`,
    `  projections differ between the two chains    ${totals.divergent}`,
    '',
    ...criteriaBlock('SEED CHAIN  html → pm → y.doc → pm → html  (what Phase E does — the gate)', snapshot.seed),
    ...criteriaBlock('CENSUS CHAIN  html → pm → html  (what collab-content-census ran — must match)', snapshot.census),
    ...table('seed chain — criterion failures', snapshot.seed.criteriaFailures, 'CRITERION'),
    ...table('seed chain — constructs dropped (tag-qualified)', snapshot.seed.droppedConstructs),
    ...table('seed chain — constructs dropped, census keys (compare with the census report)', snapshot.seed.droppedConstructsCensusKeyed),
    ...table('seed chain — additions outside the cosmetic allowlist', snapshot.seed.unexpectedAdditions),
    ...table('census chain — criterion failures', snapshot.census.criteriaFailures, 'CRITERION'),
    ...table('census chain — constructs dropped, census keys', snapshot.census.droppedConstructsCensusKeyed),
    ...table(
      'y-prosemirror — what differs between the census projection and the seed projection',
      snapshot.divergence.rows,
      'DIFFERENCE',
    ),
    'package seed gate (what htmlToPmDoc throws on — describeParseLoss) vs this audit, seed chain',
    `  gate refuses, audit lossy   (agree)                 ${gate.agreement.bothLossy}`,
    `  gate ACCEPTS, audit lossy   (BLIND SPOT — read these) ${gate.agreement.gateBlindSpot}`,
    `  gate refuses, audit clean   (gate stricter)         ${gate.agreement.gateStricter}`,
    `  both clean                                          ${gate.agreement.bothClean}`,
    '',
    ...table('gate agreement — example pages', gate.agreementRows, 'CELL'),
    ...table('gate reasons (shape only — never content)', gate.reasons, 'REASON'),
    ...table('html-mode pages with no HTML element — markdown/plain text under an html label', snapshot.taglessPages, 'FINDING'),
    ...table('documents the chain could not process (stage and error type only)', snapshot.failures, 'STAGE: ERROR'),
  ];
  return lines.join('\n');
}
