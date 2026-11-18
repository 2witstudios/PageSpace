/**
 * Publish gate — decides whether one private file may be copied to the public
 * publish bucket. Runs BEFORE the copy: the copy's HEAD shortcut returns early
 * when the asset is already public, so a check inside it would be skipped for
 * exactly the files that are already being served.
 *
 * Order:
 *   1. blocklist (refused in every mode);
 *   2. a fresh `clean` verdict (no scan), or a fresh classifier flag (no rescan);
 *   3. read the original (bounded), sniff it, and scan it with a timeout.
 *
 * Every effect comes in through `PublishGateDeps`, so each outcome is tested
 * without a database, storage or vendor. A failed side effect (recording a
 * verdict, opening a case, alerting) is logged and never makes the gate promote
 * something it would otherwise hold.
 */

import type { ContentScanVerdict, ContentScanOutcome } from '@pagespace/db/schema/content-safety';
import type { ScanGateConfig } from './scan-mode';
import { classifyMedia, decideGate, isVerdictFresh, refineScanOutcome, sniffContentType, type GateOutcome, type ScanAuditEventType } from './scan-policy';
import { scanWithTimeout, type ContentScanner, type ScanResult } from './scanner';

/**
 * Where the asset is being made public. Recorded on the audit event. `user_avatar` is a profile picture
 * upload (PR 5); `backfill` is the walk over content that was already public before the gate existed.
 */
export type PublishGateEntryPoint = 'canvas_asset' | 'canvas_thumbnail' | 'uploaded_image' | 'user_avatar' | 'backfill';

export interface PublishGateInput {
  /** Canonical sha256 of the ORIGINAL bytes. A thumbnail is gated by its original's hash. */
  contentHash: string;
  /** Private key of the original: `files/<hash>/original`. Never the derived image. */
  originalKey: string;
  declaredContentType: string | null;
  /** The page ID of the file, when there is one (an avatar or a backfilled object has none). Recorded; never shown with a reason. */
  fileId: string | null;
  userId: string | null;
  entryPoint: PublishGateEntryPoint;
}

export type PublishGateResult = { promote: true } | { promote: false; reason: 'blocked' | 'held' };

/**
 * What the gate found, for callers that act on more than promote-or-not (the avatar upload, the backfill).
 * `off`: scanning is off. `unavailable`: no vendor key. `fresh`: decided from a stored verdict, no new scan.
 */
export type GateFinding =
  | 'off' | 'blocked' | 'unavailable'
  | 'clean' | 'hash_match' | 'flagged' | 'error' | 'unscanned' | 'unverified';

export type PublishGateEvaluation = PublishGateResult & {
  finding: GateFinding;
  /** The vendor was called for this decision. */
  scanned: boolean;
  /** The case opened for a flag or a hash match, when there is one. */
  caseId: string | null;
};

function findingFor(outcome: GateOutcome): GateFinding {
  switch (outcome.kind) {
    case 'cached_clean':
      return 'clean';
    case 'cached_flagged':
      return 'flagged';
    case 'cached_unscanned':
    case 'not_scanned':
      return 'unscanned';
    case 'cached_unverified':
    case 'unverified':
      return 'unverified';
    case 'scanner_unavailable':
      return 'unavailable';
    case 'scanned':
      switch (outcome.result.kind) {
        case 'clean':
          return 'clean';
        case 'hash_match':
          return 'hash_match';
        case 'classifier_flag':
          return 'flagged';
        case 'error':
          return 'error';
        case 'unsupported_type':
          return 'unscanned';
      }
  }
}

export interface StoredVerdict {
  verdict: ContentScanVerdict;
  outcome: ContentScanOutcome | null;
  scannedAt: Date;
  /** For an `unscanned` verdict: whether the file was a type published unscanned (PDF, text, …). */
  unscannedAllowed?: boolean;
  /**
   * For a `clean` verdict: a video the classifier returned no scores for (hash lists only). Recorded clean before
   * unverified video existed, or while CONTENT_SCAN_ALLOW_UNCLASSIFIED_VIDEO was on; scanned again once it is off.
   */
  unclassifiedVideo?: true;
}

/**
 * What a stored verdict decides without a new scan, or null when the gate must scan. The one rule for reusing a
 * verdict: the gate and the backfill's dry run both use it.
 */
export function cachedOutcome(
  stored: StoredVerdict | null | undefined,
  config: Pick<ScanGateConfig, 'verdictTtlMs' | 'allowUnclassifiedVideo'>,
  now: Date,
): GateOutcome | null {
  if (!stored || !isVerdictFresh(stored.scannedAt, config.verdictTtlMs, now)) return null;
  // A clean video the classifier never scored is unverified under the strict policy: scan it again.
  if (stored.verdict === 'clean') return stored.unclassifiedVideo && !config.allowUnclassifiedVideo ? null : { kind: 'cached_clean' };
  if (stored.verdict === 'flagged' && stored.outcome === 'classifier_flag') return { kind: 'cached_flagged' };
  if (stored.verdict === 'unscanned' && stored.unscannedAllowed !== undefined) return { kind: 'cached_unscanned', allowed: stored.unscannedAllowed };
  // Once unclassified video is accepted, a stored `unverified` is scanned again (and comes back clean).
  if (stored.verdict === 'unverified' && !config.allowUnclassifiedVideo) return { kind: 'cached_unverified' };
  return null;
}

export interface VerdictRecord {
  contentHash: string;
  verdict: ContentScanVerdict;
  outcome: ContentScanOutcome;
  provider: string;
  mode: 'shadow' | 'enforce';
  scores: Record<string, unknown>;
}

/** The first bytes of the original, all of it when it fits under the limit. Null when it does not exist. */
export interface SourceRead {
  bytes: Uint8Array;
  /** False when the object is larger than the limit: `bytes` is then only its beginning. */
  complete: boolean;
}

export interface ScanAlert {
  event: 'scan_flagged';
  caseId: string;
  category: 'csam';
}

export interface ScanAuditEvent {
  eventType: ScanAuditEventType;
  contentHash: string;
  userId: string | null;
  details: Record<string, string | number | boolean | null>;
}

export interface PublishGateDeps {
  config: ScanGateConfig;
  /** Null when no vendor key is configured. */
  scanner: ContentScanner | null;
  isBlocked(contentHash: string): Promise<boolean>;
  findVerdict(contentHash: string): Promise<StoredVerdict | null>;
  readSource(key: string, maxBytes: number): Promise<SourceRead | null>;
  /**
   * `keptFlag`: the write was skipped because a verdict on the hash still stands (a classifier flag, or a hash
   * match while the hash is blocked). `keptHashMatch`: what stood was a hash match: the hash was blocked while
   * this scan ran.
   */
  recordVerdict(record: VerdictRecord): Promise<{ keptFlag: boolean; keptHashMatch?: boolean }>;
  /** PR 2's global takedown, category csam. Opens its own case and alerts. Returns the case ID. */
  takedownHashMatch(input: { contentHash: string; lists: string[] }): Promise<{ caseId?: string }>;
  /**
   * Open, or join, the case under review for the hash, and record the flagged verdict (with `scores` and the case
   * ID) in the same transaction. `firstFlag` is true when the case had no scan flag before (it was opened now, or
   * by a report): that is when staff must be alerted.
   */
  openReviewCase(input: {
    contentHash: string;
    provider: string;
    category: string;
    score: number;
    mode: 'shadow' | 'enforce';
    scores: Record<string, unknown>;
  }): Promise<{ caseId: string; created: boolean; firstFlag: boolean }>;
  alert(alert: ScanAlert): Promise<void>;
  audit(event: ScanAuditEvent): void;
  /** Called with a configuration problem, every time; the caller logs it once. */
  reportMisconfiguration(problem: string): void;
  logError(message: string, context: Record<string, string | number | boolean | null>): void;
  now(): Date;
}

/**
 * Keeps the vendor's numbers and our bookkeeping; never a URL, filename or response body. Text is recorded as
 * `text`, not as allowed or held: whether it may publish depends on each upload's declared type (text claiming
 * to be an image is held), so the next publish reads it and decides again instead of trusting a cached answer.
 */
function scoresFor(outcome: GateOutcome, contentType: string | null, sniffedText = false): Record<string, unknown> {
  const base: Record<string, unknown> = contentType ? { contentType } : {};
  if (outcome.kind === 'not_scanned') return { ...base, media: sniffedText ? 'text' : outcome.media.class };
  if (outcome.kind === 'unverified') return { ...base, classifier: false };
  if (outcome.kind !== 'scanned') return base;
  const { result } = outcome;
  switch (result.kind) {
    case 'clean':
      return { ...base, ...(result.scores ? { classifier: result.scores } : { classifier: false }) };
    case 'classifier_flag':
      return { ...base, category: result.category, score: result.score, ...(result.scores ? { classifier: result.scores } : {}) };
    case 'hash_match':
      return { ...base, lists: result.lists, matchTypes: result.matchTypes };
    case 'error':
      return { ...base, reason: result.reason, ...(result.detail ? { detail: result.detail } : {}) };
    case 'unsupported_type':
      return { ...base, unsupported: result.contentType };
  }
}

/**
 * What a failure is, for a log line: its name and, for a database error, its code. Never its message: a
 * query error's message carries the SQL parameters, which are the content hash and the scores.
 */
export function errorLabel(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown';
  const cause = (error as { cause?: unknown }).cause;
  const code = cause && typeof cause === 'object' && 'code' in cause ? String((cause as { code: unknown }).code) : null;
  return code ? `${error.name}:${code}` : error.name;
}

async function learn(
  input: PublishGateInput,
  deps: PublishGateDeps,
): Promise<{ outcome: GateOutcome; contentType: string | null; sniffedText?: boolean; vendorCalled?: boolean }> {
  const { config } = deps;
  if (!deps.scanner) return { outcome: { kind: 'scanner_unavailable' }, contentType: null };

  const stored = await deps.findVerdict(input.contentHash).catch(() => null);
  const cached = cachedOutcome(stored, config, deps.now());
  if (cached) return { outcome: cached, contentType: null };

  const provider = deps.scanner.provider;
  let source: SourceRead | null;
  try {
    source = await deps.readSource(input.originalKey, config.maxBytes);
  } catch {
    source = null;
  }
  if (!source) {
    return { outcome: { kind: 'scanned', result: { kind: 'error', provider, reason: 'unreadable_source' } }, contentType: null };
  }

  const sniffed = sniffContentType(source.bytes, { complete: source.complete });
  const media = classifyMedia(sniffed, input.declaredContentType);
  if (media.class !== 'scan') return { outcome: { kind: 'not_scanned', media }, contentType: media.contentType, sniffedText: sniffed === 'text' };
  if (!source.complete) {
    return { outcome: { kind: 'scanned', result: { kind: 'error', provider, reason: 'too_large' } }, contentType: media.contentType };
  }
  const result: ScanResult = await scanWithTimeout(
    deps.scanner,
    { contentHash: input.contentHash, mediaKind: media.mediaKind, contentType: media.contentType, bytes: source.bytes },
    config.timeoutMs,
  );
  return { outcome: refineScanOutcome(media.mediaKind, result, config), contentType: media.contentType, vendorCalled: true };
}

/**
 * Gate one asset. Throws only when the blocklist cannot be read: the caller
 * must treat that as "not promoted", never as "not blocked".
 */
export async function gatePublishAsset(input: PublishGateInput, deps: PublishGateDeps): Promise<PublishGateResult> {
  const evaluation = await evaluatePublishAsset(input, deps);
  return evaluation.promote ? { promote: true } : { promote: false, reason: evaluation.reason };
}

/** The gate, with what it found. Same order, effects and errors as `gatePublishAsset`. */
export async function evaluatePublishAsset(input: PublishGateInput, deps: PublishGateDeps): Promise<PublishGateEvaluation> {
  if (await deps.isBlocked(input.contentHash)) return { promote: false, reason: 'blocked', finding: 'blocked', scanned: false, caseId: null };

  const { config } = deps;
  if (config.mode === 'off') return { promote: true, finding: 'off', scanned: false, caseId: null };
  const mode = config.mode;
  for (const problem of config.problems) deps.reportMisconfiguration(problem);

  const { outcome, contentType, sniffedText, vendorCalled } = await learn(input, deps);
  const decision = decideGate(mode, outcome);
  const provider = deps.scanner?.provider ?? 'none';
  const context = { fileId: input.fileId, entryPoint: input.entryPoint, mode };

  let caseId: string | null = null;
  if (decision.takedown && outcome.kind === 'scanned' && outcome.result.kind === 'hash_match') {
    try {
      caseId = (await deps.takedownHashMatch({ contentHash: input.contentHash, lists: outcome.result.lists })).caseId ?? null;
    } catch (error) {
      // The case (if it opened) is resumable from the admin console. The file is still not promoted, and the
      // verdict is not cached as flagged-by-classifier, so the next publish scans and takes it down again.
      deps.logError('Publish gate: the takedown for a hash match did not complete', { ...context, error: errorLabel(error) });
    }
  }

  // A classifier flag is recorded WITH its case, in one transaction (`openReviewCase`). A recorded flag
  // short-circuits later publishes with no new case, so a flag recorded without an open case would hold the file
  // with nobody reviewing it until the verdict expired: that is what a separate write after the case could do,
  // landing after an admin dismissed the case and recorded the hash clean. If the case cannot be opened, an error
  // verdict is recorded instead: the next publish scans again and retries the case.
  let record = decision.record;
  let scores = scoresFor(outcome, contentType, sniffedText);
  if (decision.reviewCase && outcome.kind === 'scanned' && outcome.result.kind === 'classifier_flag') {
    try {
      const opened = await deps.openReviewCase({
        contentHash: input.contentHash,
        provider: outcome.result.provider,
        category: outcome.result.category,
        score: outcome.result.score,
        mode,
        scores,
      });
      caseId = opened.caseId;
      record = null;
      if (opened.created || opened.firstFlag) {
        await deps.alert({ event: 'scan_flagged', caseId: opened.caseId, category: 'csam' }).catch((error: unknown) =>
          deps.logError('Publish gate: the alert for a flagged scan failed', { ...context, caseId: opened.caseId, error: errorLabel(error) }),
        );
      }
    } catch (error) {
      deps.logError('Publish gate: could not open a review case for a flagged scan', { ...context, error: errorLabel(error) });
      record = { verdict: 'error', outcome: 'error' };
      scores = { ...scores, reason: 'review_case_failed' };
    }
  }

  let promote = decision.promote;
  // Set when this result lost to a verdict that stands (a classifier flag, or a hash match on a blocked hash).
  let keptFlag = false;
  let blockedMidScan = false;
  if (record) {
    const written = await deps
      .recordVerdict({
        contentHash: input.contentHash,
        verdict: record.verdict,
        outcome: record.outcome,
        provider: outcome.kind === 'scanned' || outcome.kind === 'unverified' ? (outcome.kind === 'scanned' ? outcome.result.provider : outcome.provider) : provider,
        mode,
        scores,
      })
      .catch((error: unknown) => {
        deps.logError('Publish gate: could not record a scan verdict', { ...context, error: errorLabel(error) });
        return null;
      });
    // Another publish flagged this hash and its flag stands: this result does not override it. Enforce holds,
    // and holds too when the write failed: whether a flag stands could not be told, and couldn't-check is never
    // read as allowed.
    if ((written === null || written.keptFlag) && mode === 'enforce') promote = false;
    keptFlag = written?.keptFlag === true;
    // A hash match stood: the hash was blocked after the blocklist check above. Refused in every mode, as a
    // blocked hash is: shadow's "publish anyway" never covers blocked bytes (an avatar has no later recheck).
    if (written?.keptHashMatch) {
      blockedMidScan = true;
      promote = false;
    }
  }

  if (decision.audit) {
    const details: ScanAuditEvent['details'] = { ...context, promoted: promote, provider, caseId, contentType };
    if (outcome.kind === 'scanned' && outcome.result.kind === 'error') details.reason = outcome.result.reason;
    if (outcome.kind === 'scanned' && outcome.result.kind === 'classifier_flag') details.score = outcome.result.score;
    deps.audit({ eventType: decision.audit, contentHash: input.contentHash, userId: input.userId, details });
  }

  // Only a call that reached the vendor counts: an unreadable or oversized source is an error with no call.
  const scanned = vendorCalled === true;
  // A result that lost to a standing flag reports the flag: the backfill acts on the finding, not on `promote`.
  if (blockedMidScan) return { promote: false, reason: 'blocked', finding: 'blocked', scanned, caseId };
  const finding: GateFinding = keptFlag ? 'flagged' : findingFor(outcome);
  return promote
    ? { promote: true, finding, scanned, caseId }
    : { promote: false, reason: 'held', finding, scanned, caseId };
}
