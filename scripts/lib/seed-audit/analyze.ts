import { pmDocToYDoc, yDocToPmDoc } from '@pagespace/editor/collab-document';
import type { DomWorkspace } from '@pagespace/editor/dom-workspace';
import {
  describeParseLoss,
  parseHtmlElementUnchecked,
  stripNonContentElements,
} from '@pagespace/editor/html-to-ydoc';
import { pmDocToHtmlIn } from '@pagespace/editor/y-doc-to-html';
import {
  ALLOWED_COSMETIC_ADDITIONS,
  constructDifference,
  constructKeysOf,
} from '@pagespace/editor/seed-fidelity';
import {
  countContent,
  counterDecreases,
  isTagless,
  spaceCollapsedText,
  visibleText,
  type ContentCounts,
} from './criteria';

/**
 * One stored document through BOTH chains, judged by the three criteria on
 * each, with the difference between the chains isolated.
 *
 *   census chain:  HTML → ProseMirror → HTML
 *   seed chain:    HTML → ProseMirror → Y.Doc → ProseMirror → HTML
 *
 * The census chain is what `apps/web/scripts/collab-content-census.ts` ran;
 * the seed chain is what Phase E will actually do to the document. They are
 * run side by side on the same parse so the comparison is direct: if the two
 * projections differ, the ProseMirror schema is not what changed — the only
 * thing between them is `y-prosemirror` (`prosemirrorToYXmlFragment` and
 * `yXmlFragmentToProseMirrorRootNode`), and the divergence names what it
 * altered.
 *
 * NEVER RETURNS DOCUMENT CONTENT. Every field is a boolean, a count, a
 * construct key (`el:img`, `attr:ul@class`), a counter name or an error type.
 */

/** One chain's verdict on one page. */
export interface ChainResult {
  /** Criterion 1: `render(parse(h1)) == h1`. */
  stable: boolean;
  /** Criterion 2: counters that DECREASED from `src` to `h1`. Empty means none did. */
  counterDecreases: string[];
  /** Criterion 3: whitespace-stripped visible text equal between `src` and `h1`. */
  textPreserved: boolean;
  /**
   * Diagnostic, never a verdict: text equal with all whitespace stripped but
   * NOT with runs collapsed to a single space — a space vanished or appeared
   * between words. See `visibleText` for why this is not criterion 3.
   */
  whitespaceOnlyTextChange: boolean;
  /** Construct keys present in `src` and absent from `h1` — presence-based, the census's own measure. */
  droppedConstructs: string[];
  /** Construct keys `h1` gained that are NOT in `ALLOWED_COSMETIC_ADDITIONS`. */
  unexpectedAdditions: string[];
}

/** True when any of the three hard blockers failed. */
export function isLossy(result: ChainResult): boolean {
  return !result.stable || result.counterDecreases.length > 0 || !result.textPreserved;
}

/** What `y-prosemirror` changed, when the two chains' projections differ. */
export interface ChainDivergence {
  /** Counters whose value differs between the census projection and the seed projection. */
  counterChanges: string[];
  textChanged: boolean;
  /** Constructs the census chain rendered that the seed chain did not. */
  constructsLost: string[];
  /** Constructs the seed chain rendered that the census chain did not. */
  constructsGained: string[];
}

export type PageAudit =
  | {
      status: 'audited';
      /** No HTML element at all — markdown or plain text under an html label. */
      tagless: boolean;
      census: ChainResult;
      seed: ChainResult;
      /** `null` when both chains rendered byte-identical `h1`. */
      divergence: ChainDivergence | null;
      /**
       * What the package's own seed gate (`describeParseLoss`, the check
       * `htmlToYDoc` throws on) says about this page, as content-free reason
       * SHAPES — `dropped <img>`, `visible text changed` — with the counts the
       * reasons carry stripped off so they tally.
       */
      gateReasons: string[];
    }
  | {
      /**
       * The document could not be taken through the chain at all. Only the
       * stage and the error TYPE are kept: ProseMirror quotes the offending
       * markup in its messages, and this runs against production user data.
       */
      status: 'failed';
      stage: FailureStage;
      errorName: string;
    };

export type FailureStage = 'parse' | 'render' | 'ydoc' | 'gate';

type PmNode = ReturnType<typeof parseHtmlElementUnchecked>;

/**
 * `htmlToPmDoc` is deliberately NOT used to parse: it throws on the very
 * pages this audit exists to describe. `parseHtmlElementUnchecked` is the
 * same `DOMParser` call over the same frozen schema, minus the throw — and
 * `describeParseLoss` is run over the same parse so the gate's own verdict is
 * on the record for every page without parsing it twice.
 */
function parse(root: Element): PmNode {
  return parseHtmlElementUnchecked(root as HTMLElement);
}

function throughYDoc(doc: PmNode): PmNode {
  const yDoc = pmDocToYDoc(doc);
  try {
    return yDocToPmDoc(yDoc);
  } finally {
    // One Y.Doc per page per chain over thousands of pages; each holds its
    // own event emitters until destroyed.
    yDoc.destroy();
  }
}

interface Measured {
  counts: ContentCounts;
  text: string;
  spacedText: string;
  constructs: Set<string>;
}

function measure(root: Element): Measured {
  return {
    counts: countContent(root),
    text: visibleText(root),
    spacedText: spaceCollapsedText(root),
    constructs: constructKeysOf(root),
  };
}

/** The three criteria (plus the presence-based construct diff) for one rendered `h1` against its source. */
export function judgeChain(sourceRoot: Element, renderedRoot: Element, stable: boolean): ChainResult {
  return judge(measure(sourceRoot), measure(renderedRoot), stable);
}

function judge(source: Measured, rendered: Measured, stable: boolean): ChainResult {
  const textPreserved = source.text === rendered.text;
  return {
    stable,
    counterDecreases: counterDecreases(source.counts, rendered.counts),
    textPreserved,
    whitespaceOnlyTextChange: textPreserved && source.spacedText !== rendered.spacedText,
    droppedConstructs: constructDifference(source.constructs, rendered.constructs),
    unexpectedAdditions: constructDifference(rendered.constructs, source.constructs).filter(
      (key) => !ALLOWED_COSMETIC_ADDITIONS.has(key),
    ),
  };
}

/** What the seed projection changed relative to the census projection of the same page. */
export function divergenceBetween(censusRoot: Element, seedRoot: Element): ChainDivergence {
  return diverge(measure(censusRoot), measure(seedRoot));
}

function diverge(census: Measured, seed: Measured): ChainDivergence {
  return {
    counterChanges: Object.keys(census.counts).filter((key) => census.counts[key] !== seed.counts[key]),
    textChanged: census.text !== seed.text,
    constructsLost: constructDifference(census.constructs, seed.constructs),
    constructsGained: constructDifference(seed.constructs, census.constructs),
  };
}

/**
 * Gate reasons carry counts ("dropped 2 <img> element(s)",
 * "visible text changed (140 characters in, 120 out)"). The count is per
 * page; the SHAPE is what tallies across pages.
 */
export function gateReasonShape(reason: string): string {
  const dropped = /^dropped \d+ <([a-z0-9-]+)> element\(s\)$/u.exec(reason);
  if (dropped) return `dropped <${dropped[1]}>`;
  if (/^visible text changed \(/u.test(reason)) return 'visible text changed';
  return reason;
}

/**
 * Runs the page. `workspace` is the run's single happy-dom window — every
 * parse and every render goes through it, so a run creates one window, not
 * five per page. Errors are caught per stage so a page that ProseMirror
 * cannot parse is a row in the failure table, not the end of the run.
 */
export function auditPage(html: string, workspace: DomWorkspace): PageAudit {
  let stage: FailureStage = 'parse';
  try {
    const sourceRoot = workspace.parse(html);
    stripNonContentElements(sourceRoot);
    const source = measure(sourceRoot);
    const tagless = isTagless(sourceRoot);
    const sourceDoc = parse(sourceRoot);

    // Census chain: HTML → PM → HTML, then once more for stability.
    stage = 'render';
    const h1 = pmDocToHtmlIn(sourceDoc, workspace);
    const h1Root = workspace.parse(h1);
    const h2 = pmDocToHtmlIn(parse(h1Root), workspace);
    const censusRendered = measure(h1Root);

    // Seed chain: the same parse, through a Y.Doc and back, then once more.
    stage = 'ydoc';
    const h1y = pmDocToHtmlIn(throughYDoc(sourceDoc), workspace);
    const h1yRoot = workspace.parse(h1y);
    const h2y = pmDocToHtmlIn(throughYDoc(parse(h1yRoot)), workspace);
    const seedRendered = measure(h1yRoot);

    stage = 'gate';
    const gateReasons = describeParseLoss(sourceRoot, sourceDoc).map(gateReasonShape);

    return {
      status: 'audited',
      tagless,
      census: judge(source, censusRendered, h1 === h2),
      seed: judge(source, seedRendered, h1y === h2y),
      divergence: h1 === h1y ? null : diverge(censusRendered, seedRendered),
      gateReasons,
    };
  } catch (error) {
    return {
      status: 'failed',
      stage,
      errorName: error instanceof Error ? error.name : 'unknown',
    };
  }
}
