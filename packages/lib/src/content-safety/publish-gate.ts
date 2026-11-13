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
import { classifyMedia, decideGate, isVerdictFresh, sniffContentType, type GateOutcome, type ScanAuditEventType } from './scan-policy';
import { scanWithTimeout, type ContentScanner, type ScanResult } from './scanner';

/** Where in the publish flow the asset is being promoted. Recorded on the audit event. */
export type PublishGateEntryPoint = 'canvas_asset' | 'canvas_thumbnail' | 'uploaded_image';

export interface PublishGateInput {
  /** Canonical sha256 of the ORIGINAL bytes. A thumbnail is gated by its original's hash. */
  contentHash: string;
  /** Private key of the original: `files/<hash>/original`. Never the derived image. */
  originalKey: string;
  declaredContentType: string | null;
  /** The page ID of the file. Recorded; never shown to the publisher with a reason. */
  fileId: string;
  userId: string | null;
  entryPoint: PublishGateEntryPoint;
}

export type PublishGateResult = { promote: true } | { promote: false; reason: 'blocked' | 'held' };

export interface StoredVerdict {
  verdict: ContentScanVerdict;
  outcome: ContentScanOutcome | null;
  scannedAt: Date;
  /** For an `unscanned` verdict: whether the file was a type published unscanned (PDF, text, …). */
  unscannedAllowed?: boolean;
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
  recordVerdict(record: VerdictRecord): Promise<void>;
  /** PR 2's global takedown, category csam. Opens its own case and alerts. Returns the case ID. */
  takedownHashMatch(input: { contentHash: string; lists: string[] }): Promise<{ caseId?: string }>;
  /**
   * Open, or join, the case under review for the hash. `firstFlag` is true when the case had no scan flag
   * before (it was opened now, or by a report): that is when staff must be alerted.
   */
  openReviewCase(input: { contentHash: string; provider: string; category: string; score: number; mode: 'shadow' | 'enforce' }): Promise<{ caseId: string; created: boolean; firstFlag: boolean }>;
  alert(alert: ScanAlert): Promise<void>;
  audit(event: ScanAuditEvent): void;
  /** Called with a configuration problem, every time; the caller logs it once. */
  reportMisconfiguration(problem: string): void;
  logError(message: string, context: Record<string, string | number | boolean | null>): void;
  now(): Date;
}

/** Keeps the vendor's numbers and our bookkeeping; never a URL, filename or response body. */
function scoresFor(outcome: GateOutcome, contentType: string | null): Record<string, unknown> {
  const base: Record<string, unknown> = contentType ? { contentType } : {};
  if (outcome.kind === 'not_scanned') return { ...base, media: outcome.media.class };
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
function errorLabel(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown';
  const cause = (error as { cause?: unknown }).cause;
  const code = cause && typeof cause === 'object' && 'code' in cause ? String((cause as { code: unknown }).code) : null;
  return code ? `${error.name}:${code}` : error.name;
}

async function learn(input: PublishGateInput, deps: PublishGateDeps): Promise<{ outcome: GateOutcome; contentType: string | null }> {
  const { config } = deps;
  if (!deps.scanner) return { outcome: { kind: 'scanner_unavailable' }, contentType: null };

  const stored = await deps.findVerdict(input.contentHash).catch(() => null);
  if (stored && isVerdictFresh(stored.scannedAt, config.verdictTtlMs, deps.now())) {
    if (stored.verdict === 'clean') return { outcome: { kind: 'cached_clean' }, contentType: null };
    if (stored.verdict === 'flagged' && stored.outcome === 'classifier_flag') return { outcome: { kind: 'cached_flagged' }, contentType: null };
    if (stored.verdict === 'unscanned' && stored.unscannedAllowed !== undefined) {
      return { outcome: { kind: 'cached_unscanned', allowed: stored.unscannedAllowed }, contentType: null };
    }
  }

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

  const media = classifyMedia(sniffContentType(source.bytes), input.declaredContentType);
  if (media.class !== 'scan') return { outcome: { kind: 'not_scanned', media }, contentType: media.contentType };
  if (!source.complete) {
    return { outcome: { kind: 'scanned', result: { kind: 'error', provider, reason: 'too_large' } }, contentType: media.contentType };
  }
  const result: ScanResult = await scanWithTimeout(
    deps.scanner,
    { contentHash: input.contentHash, mediaKind: media.mediaKind, contentType: media.contentType, bytes: source.bytes },
    config.timeoutMs,
  );
  return { outcome: { kind: 'scanned', result }, contentType: media.contentType };
}

/**
 * Gate one asset. Throws only when the blocklist cannot be read: the caller
 * must treat that as "not promoted", never as "not blocked".
 */
export async function gatePublishAsset(input: PublishGateInput, deps: PublishGateDeps): Promise<PublishGateResult> {
  if (await deps.isBlocked(input.contentHash)) return { promote: false, reason: 'blocked' };

  const { config } = deps;
  if (config.mode === 'off') return { promote: true };
  const mode = config.mode;
  for (const problem of config.problems) deps.reportMisconfiguration(problem);

  const { outcome, contentType } = await learn(input, deps);
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

  // The case is opened BEFORE the flag is recorded. A recorded flag short-circuits later publishes with no new
  // case, so a flag recorded without its case would never reach a person until the verdict expired. If the case
  // cannot be opened, an error verdict is recorded instead: the next publish scans again and retries the case.
  let record = decision.record;
  let scores = scoresFor(outcome, contentType);
  if (decision.reviewCase && outcome.kind === 'scanned' && outcome.result.kind === 'classifier_flag') {
    try {
      const opened = await deps.openReviewCase({
        contentHash: input.contentHash,
        provider: outcome.result.provider,
        category: outcome.result.category,
        score: outcome.result.score,
        mode,
      });
      caseId = opened.caseId;
      scores = { ...scores, caseId: opened.caseId };
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

  if (record) {
    await deps
      .recordVerdict({
        contentHash: input.contentHash,
        verdict: record.verdict,
        outcome: record.outcome,
        provider: outcome.kind === 'scanned' ? outcome.result.provider : provider,
        mode,
        scores,
      })
      .catch((error: unknown) => deps.logError('Publish gate: could not record a scan verdict', { ...context, error: errorLabel(error) }));
  }

  if (decision.audit) {
    const details: ScanAuditEvent['details'] = { ...context, promoted: decision.promote, provider, caseId, contentType };
    if (outcome.kind === 'scanned' && outcome.result.kind === 'error') details.reason = outcome.result.reason;
    if (outcome.kind === 'scanned' && outcome.result.kind === 'classifier_flag') details.score = outcome.result.score;
    deps.audit({ eventType: decision.audit, contentHash: input.contentHash, userId: input.userId, details });
  }

  return decision.promote ? { promote: true } : { promote: false, reason: 'held' };
}
