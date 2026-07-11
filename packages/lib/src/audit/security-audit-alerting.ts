/**
 * Security Audit Chain Verification Alerting (#544)
 *
 * Provides:
 * - Alert callback on chain verification failure
 * - Periodic cron-style verification scheduler
 * - Configurable alert handler for integration with external systems
 */

import { loggers } from '../logging/logger-config';
import {
  verifySecurityAuditChain,
  type SecurityChainVerificationResult,
  type VerifySecurityChainOptions,
  type VerifySecurityChainDeps,
} from './security-audit-chain-verifier';

/**
 * Alert payload sent when chain verification detects an issue.
 *
 * `source: 'preflight'` is fired synchronously by the SIEM delivery worker
 * when its batch-time chain check detects tamper, BEFORE any events leave
 * the system. Unlike 'periodic'/'manual' alerts (which come from a full DB
 * scan via verifyAndAlert), preflight alerts carry a SYNTHETIC
 * SecurityChainVerificationResult that describes only the specific break
 * the worker saw — totalEntries and the other counts reflect the batch, not
 * the whole table.
 */
export interface ChainVerificationAlert {
  result: SecurityChainVerificationResult;
  triggeredAt: Date;
  source:
    | 'periodic'
    | 'manual'
    | 'preflight'
    | 'append'
    | 'anchor_publish'
    | 'anchor_verify'
    | 'break_glass';
}

/**
 * Details of a single chain break caught by the SIEM delivery preflight.
 * Passed to notifyChainPreflightFailure so the worker doesn't have to
 * synthesize SecurityChainVerificationResult itself — keeps the worker
 * decoupled from the verifier result shape.
 */
export interface PreflightChainBreakDetails {
  /** Which audit source the break was detected in. */
  auditSource: 'activity_logs' | 'security_audit_log';
  /** The specific entry id at which the break was detected. */
  entryId: string;
  /** 0-based index inside the source's sub-batch. */
  breakAtIndex: number;
  /** Classification of the break — see siem-chain-verifier. */
  breakReason: 'hash_mismatch' | 'chain_break' | 'missing_hash';
  expectedHash: string | null;
  actualHash: string | null;
  /**
   * Total number of entries for this source in the run's merged batch.
   * Required so alert metrics reflect the real batch size rather than a
   * prefix derived from breakAtIndex.
   */
  sourceBatchTotalEntries: number;
}

/**
 * Handler invoked when a verification alert fires.
 */
export type ChainAlertHandler = (alert: ChainVerificationAlert) => void | Promise<void>;

let alertHandler: ChainAlertHandler | null = null;

/**
 * Set the alert handler for chain verification failures.
 * Called during app startup to wire alerts to logging, email, Slack, etc.
 */
export function setChainAlertHandler(handler: ChainAlertHandler | null): void {
  alertHandler = handler;
}

/**
 * Get the current alert handler (for testing).
 */
export function getChainAlertHandler(): ChainAlertHandler | null {
  return alertHandler;
}

/**
 * Run chain verification and fire an alert if the chain is invalid.
 *
 * @param source - Whether triggered by periodic cron or manual invocation
 * @param options - Verification options passed to verifySecurityAuditChain
 * @param deps - Injected client passed through to verifySecurityAuditChain (defaults to the main app db)
 * @returns The verification result
 */
export async function verifyAndAlert(
  source: 'periodic' | 'manual' = 'manual',
  options?: VerifySecurityChainOptions,
  deps?: VerifySecurityChainDeps
): Promise<SecurityChainVerificationResult> {
  const result = await verifySecurityAuditChain(options, deps);

  if (!result.isValid && alertHandler) {
    const alert: ChainVerificationAlert = {
      result,
      triggeredAt: new Date(),
      source,
    };

    try {
      await alertHandler(alert);
    } catch (error) {
      loggers.security.error('[SecurityAuditAlerting] Alert handler failed:', { error });
    }
  }

  return result;
}

/**
 * Fire a preflight chain-break alert through the globally-registered handler.
 *
 * Called by the SIEM delivery worker when its Phase 2c verification detects
 * tamper. The worker passes narrow break details; this helper wraps them in
 * a synthetic SecurityChainVerificationResult so the existing alert handler
 * interface stays unchanged. If no handler is registered (e.g. in the
 * processor worker context before a startup wiring exists), this is a no-op.
 *
 * Handler errors are swallowed with a logged warn — a broken alert system
 * must not mask the original tamper detection. The caller has already
 * recorded the error on the cursor and will halt delivery regardless.
 */
export async function notifyChainPreflightFailure(
  details: PreflightChainBreakDetails
): Promise<void> {
  if (!alertHandler) return;

  const now = new Date();
  const reasonMessage =
    details.breakReason === 'hash_mismatch'
      ? 'Hash mismatch - entry data may have been modified'
      : details.breakReason === 'chain_break'
        ? 'Chain link broken - previousHash does not match the expected anchor'
        : 'Missing hash - entry has no stored logHash';

  // totalEntries reflects the full source-scoped batch; entriesVerified is
  // the prefix the verifier walked up to and including the break; validEntries
  // is the prefix that passed before the break. These three together give
  // operators an accurate "how much did we see" signal without conflating
  // prefix-to-break counts with batch size.
  const syntheticResult: SecurityChainVerificationResult = {
    isValid: false,
    totalEntries: details.sourceBatchTotalEntries,
    entriesVerified: details.breakAtIndex + 1,
    validEntries: details.breakAtIndex,
    invalidEntries: 1,
    breakPoint: {
      entryId: details.entryId,
      timestamp: now,
      position: details.breakAtIndex,
      storedHash: details.actualHash ?? '',
      computedHash: details.expectedHash ?? '',
      previousHashUsed: '',
      description: `SIEM preflight chain break at ${details.auditSource}[${details.breakAtIndex}] (${details.entryId}): ${reasonMessage}`,
    },
    firstEntryId: null,
    lastEntryId: details.entryId,
    verificationStartedAt: now,
    verificationCompletedAt: now,
    durationMs: 0,
  };

  const alert: ChainVerificationAlert = {
    result: syntheticResult,
    triggeredAt: now,
    source: 'preflight',
  };

  try {
    await alertHandler(alert);
  } catch (error) {
    loggers.security.error('[SecurityAuditAlerting] Preflight alert handler failed:', { error });
  }
}

/**
 * Details of a verify-on-append failure caught by the audit chainer worker
 * (#890 Phase 2). Shapes mirror PreflightChainBreakDetails, but the source is
 * the just-appended security_audit_log segment re-read after commit, not a
 * SIEM delivery batch — reasons come from verifyAppendedSegment (chain-step.ts).
 */
export interface AppendVerificationFailureDetails {
  /** id of the chained row at which verification broke. */
  entryId: string;
  /** 0-based index inside the just-appended segment. */
  breakAtIndex: number;
  /** Classification from verifyAppendedSegment. */
  breakReason: 'hash_mismatch' | 'linkage_break' | 'missing_emission_hash';
  expectedHash: string | null;
  actualHash: string | null;
  /** Total rows in the appended segment. */
  segmentTotalRows: number;
  /** The chain head the segment was chained from (for forensics). */
  priorHead: string;
}

/**
 * Fire a verify-on-append failure alert through the globally-registered
 * handler. Called by the audit chainer worker when its post-commit
 * re-verification of a just-written segment fails — the loud path beside the
 * worker's own console.error. Same contract as notifyChainPreflightFailure:
 * no registered handler → no-op; handler errors are swallowed with a logged
 * error so a broken alert surface never masks the detection itself.
 */
export async function notifyChainAppendVerificationFailure(
  details: AppendVerificationFailureDetails
): Promise<void> {
  if (!alertHandler) return;

  const now = new Date();
  const reasonMessage =
    details.breakReason === 'hash_mismatch'
      ? 'Recomputed chain hash does not match the stored event_hash'
      : details.breakReason === 'linkage_break'
        ? 'previous_hash does not link to the preceding row'
        : 'Chainer-written row has no stored emission_hash';

  const syntheticResult: SecurityChainVerificationResult = {
    isValid: false,
    totalEntries: details.segmentTotalRows,
    entriesVerified: details.breakAtIndex + 1,
    validEntries: details.breakAtIndex,
    invalidEntries: 1,
    breakPoint: {
      entryId: details.entryId,
      timestamp: now,
      position: details.breakAtIndex,
      storedHash: details.actualHash ?? '',
      computedHash: details.expectedHash ?? '',
      previousHashUsed: details.priorHead,
      description: `Chainer verify-on-append break at segment[${details.breakAtIndex}] (${details.entryId}): ${reasonMessage}`,
    },
    firstEntryId: null,
    lastEntryId: details.entryId,
    verificationStartedAt: now,
    verificationCompletedAt: now,
    durationMs: 0,
  };

  const alert: ChainVerificationAlert = {
    result: syntheticResult,
    triggeredAt: now,
    source: 'append',
  };

  try {
    await alertHandler(alert);
  } catch (error) {
    loggers.security.error('[SecurityAuditAlerting] Append verification alert handler failed:', {
      error,
    });
  }
}

/**
 * Details of a repeated anchor-publish failure (#890 Phase 2, leaf 3). Fired
 * by the chainer's anchor hook when a witness surface (S3 Object-Lock or the
 * receipt table) keeps rejecting publishes — chaining itself is unaffected
 * (publish failure never blocks it), but a chain running unwitnessed for long
 * is exactly the window a tamper needs, so operators must hear about it.
 */
export interface AnchorPublishFailureDetails {
  /** Which publisher kept failing ('s3' | 'receipt'). */
  publisherName: string;
  /** Length of the current consecutive-failure streak for that publisher. */
  consecutiveFailures: number;
  /** chain_seq of the head that could not be anchored. */
  chainSeq: number;
  /** event_hash of the head that could not be anchored. */
  head: string;
  /** Message of the most recent publish error. */
  errorMessage: string;
}

/**
 * Fire a repeated anchor-publish failure alert through the globally-registered
 * handler. Same contract as the other notify helpers: no handler → no-op;
 * handler errors are swallowed with a logged error so a broken alert surface
 * never breaks the chainer.
 *
 * The synthetic result reuses the chain-verification alert shape (the one
 * registered handler surface): isValid=false marks "the trust plane needs
 * attention", and the breakPoint description carries the anchor specifics —
 * handlers distinguish via source='anchor_publish'.
 */
export async function notifyAnchorPublishFailure(
  details: AnchorPublishFailureDetails
): Promise<void> {
  if (!alertHandler) return;

  const now = new Date();
  const syntheticResult: SecurityChainVerificationResult = {
    isValid: false,
    totalEntries: 0,
    entriesVerified: 0,
    validEntries: 0,
    invalidEntries: 0,
    breakPoint: {
      entryId: `anchor-${details.chainSeq}`,
      timestamp: now,
      position: 0,
      storedHash: details.head,
      computedHash: '',
      previousHashUsed: '',
      description: `Anchor publish to '${details.publisherName}' failed ${details.consecutiveFailures} consecutive times for head at chain_seq ${details.chainSeq}: ${details.errorMessage}. The chain is appending unwitnessed.`,
    },
    firstEntryId: null,
    lastEntryId: null,
    verificationStartedAt: now,
    verificationCompletedAt: now,
    durationMs: 0,
  };

  const alert: ChainVerificationAlert = {
    result: syntheticResult,
    triggeredAt: now,
    source: 'anchor_publish',
  };

  try {
    await alertHandler(alert);
  } catch (error) {
    loggers.security.error('[SecurityAuditAlerting] Anchor publish alert handler failed:', {
      error,
    });
  }
}

/**
 * Details of a failed anchor-vs-chain verification (#890 Phase 2, leaf 5).
 * Fired by the full audit verifier when matchAnchorsAgainstChain reports
 * anything but a clean match: a hash_mismatch means the chain was rewritten
 * under a witnessed head — the exact tamper class chain-consistency alone
 * cannot see; a seq_gap means rows below a witnessed head are missing; an
 * unverifiable anchor means the witness statement itself cannot be trusted.
 */
export interface AnchorVerificationFailureDetails {
  anchorsChecked: number;
  hashMismatches: number;
  seqGaps: number;
  unverifiable: number;
  /** The lowest-seq failing anchor, for forensics. */
  firstFailure: {
    chainSeq: number;
    verdict: 'hash_mismatch' | 'seq_gap' | 'unverifiable';
    anchorHead: string;
    chainHead: string | null;
  };
}

/**
 * Fire an anchor-verification failure alert through the globally-registered
 * handler. Same contract as the other notify helpers: no handler → no-op;
 * handler errors are swallowed with a logged error.
 */
export async function notifyAnchorVerificationFailure(
  details: AnchorVerificationFailureDetails
): Promise<void> {
  if (!alertHandler) return;

  const now = new Date();
  const syntheticResult: SecurityChainVerificationResult = {
    isValid: false,
    totalEntries: details.anchorsChecked,
    entriesVerified: details.anchorsChecked,
    validEntries:
      details.anchorsChecked -
      (details.hashMismatches + details.seqGaps + details.unverifiable),
    invalidEntries: details.hashMismatches + details.seqGaps + details.unverifiable,
    breakPoint: {
      entryId: `anchor-${details.firstFailure.chainSeq}`,
      timestamp: now,
      position: 0,
      storedHash: details.firstFailure.chainHead ?? '',
      computedHash: details.firstFailure.anchorHead,
      previousHashUsed: '',
      description:
        `Anchor verification FAILED: ${details.hashMismatches} hash mismatch(es), ${details.seqGaps} seq gap(s), ` +
        `${details.unverifiable} unverifiable of ${details.anchorsChecked} anchors checked. ` +
        `First failure at chain_seq ${details.firstFailure.chainSeq} (${details.firstFailure.verdict}): ` +
        `witnessed head ${details.firstFailure.anchorHead}, chain has ${details.firstFailure.chainHead ?? 'no row'}. ` +
        'A mismatch under a witnessed head means the chain was rewritten after anchoring.',
    },
    firstEntryId: null,
    lastEntryId: null,
    verificationStartedAt: now,
    verificationCompletedAt: now,
    durationMs: 0,
  };

  const alert: ChainVerificationAlert = {
    result: syntheticResult,
    triggeredAt: now,
    source: 'anchor_verify',
  };

  try {
    await alertHandler(alert);
  } catch (error) {
    loggers.security.error('[SecurityAuditAlerting] Anchor verification alert handler failed:', {
      error,
    });
  }
}

/**
 * Details of a zero-receipt anchor verification failure (#890 Phase 2 FIX).
 * Fired by the full audit verifier when anchoring is enabled and the chain
 * is non-empty but NO anchor receipts exist: under the epic's threat model
 * (attacker owns the audit DB) a purge of the receipt table must read as a
 * failed verification, never as "anchoring not configured yet".
 */
export interface AnchorReceiptsMissingDetails {
  /** How many chain rows exist while zero receipts do (probe count, ≥1). */
  chainRowsSeen: number;
}

/**
 * Fire a zero-receipt anchor-verification failure alert through the
 * globally-registered handler. Same contract as the other notify helpers:
 * no handler → no-op; handler errors are swallowed with a logged error.
 */
export async function notifyAnchorReceiptsMissing(
  details: AnchorReceiptsMissingDetails
): Promise<void> {
  if (!alertHandler) return;

  const now = new Date();
  const syntheticResult: SecurityChainVerificationResult = {
    isValid: false,
    totalEntries: 0,
    entriesVerified: 0,
    validEntries: 0,
    invalidEntries: 0,
    breakPoint: {
      entryId: 'anchor-receipts-missing',
      timestamp: now,
      position: 0,
      storedHash: '',
      computedHash: '',
      previousHashUsed: '',
      description:
        `Anchor verification FAILED: anchoring is enabled and the chain is non-empty (≥${details.chainRowsSeen} row(s) seen), ` +
        'but zero anchor receipts exist. Either the chainer has never published a witness (check its logs and the ' +
        'AUDIT_ANCHOR_* env), or the receipt table was purged — which is exactly what a DB-owning attacker rewriting ' +
        'the chain would do first. Verify against the S3 WORM witness before trusting this chain.',
    },
    firstEntryId: null,
    lastEntryId: null,
    verificationStartedAt: now,
    verificationCompletedAt: now,
    durationMs: 0,
  };

  const alert: ChainVerificationAlert = {
    result: syntheticResult,
    triggeredAt: now,
    source: 'anchor_verify',
  };

  try {
    await alertHandler(alert);
  } catch (error) {
    loggers.security.error('[SecurityAuditAlerting] Anchor receipts-missing alert handler failed:', {
      error,
    });
  }
}

/**
 * Details of an active Admin-DB break-glass degrade (#890 Phase 2, leaf 5).
 * Fired ONCE per process by the audit write bind point when the resolved
 * mode is 'break-glass': audit writes are going to the MAIN application
 * database — an emergency rollback state, never a supported steady state.
 */
export interface AdminDbBreakGlassDetails {
  /** The mode-decision reason from resolveAdminDbMode. */
  reason: string;
}

/**
 * Fire an Admin-DB break-glass alert through the globally-registered handler.
 * Same contract as the other notify helpers: no handler → no-op; handler
 * errors are swallowed with a logged error so a broken alert surface never
 * breaks the (already degraded) audit path. The console banner and the
 * self-recorded security event fire regardless — this is the third,
 * externally-routable channel.
 */
export async function notifyAdminDbBreakGlass(
  details: AdminDbBreakGlassDetails
): Promise<void> {
  if (!alertHandler) return;

  const now = new Date();
  const syntheticResult: SecurityChainVerificationResult = {
    isValid: false,
    totalEntries: 0,
    entriesVerified: 0,
    validEntries: 0,
    invalidEntries: 0,
    breakPoint: {
      entryId: 'admin-db-break-glass',
      timestamp: now,
      position: 0,
      storedHash: '',
      computedHash: '',
      previousHashUsed: '',
      description:
        `Admin DB break-glass is ACTIVE: audit writes are degraded to the MAIN application database (${details.reason}). ` +
        'Provision the Admin PG, set ADMIN_DATABASE_URL, and disarm ADMIN_DB_BREAK_GLASS.',
    },
    firstEntryId: null,
    lastEntryId: null,
    verificationStartedAt: now,
    verificationCompletedAt: now,
    durationMs: 0,
  };

  const alert: ChainVerificationAlert = {
    result: syntheticResult,
    triggeredAt: now,
    source: 'break_glass',
  };

  try {
    await alertHandler(alert);
  } catch (error) {
    loggers.security.error('[SecurityAuditAlerting] Break-glass alert handler failed:', {
      error,
    });
  }
}

let periodicTimer: ReturnType<typeof setInterval> | null = null;
let verificationInProgress = false;

/**
 * Start periodic chain verification on an interval.
 * Replaces any previously running scheduler.
 * Skips a tick if the previous verification is still running to prevent overlap.
 *
 * @param intervalMs - Interval between verifications in milliseconds
 * @param options - Verification options for each run
 */
export function startPeriodicVerification(
  intervalMs: number,
  options?: VerifySecurityChainOptions
): void {
  stopPeriodicVerification();

  periodicTimer = setInterval(() => {
    if (verificationInProgress) return;
    verificationInProgress = true;
    verifyAndAlert('periodic', options)
      .catch((error) => {
        loggers.security.error('[SecurityAuditAlerting] Periodic verification failed:', { error });
      })
      .finally(() => {
        verificationInProgress = false;
      });
  }, intervalMs);

  periodicTimer.unref();
}

/**
 * Stop periodic chain verification.
 */
export function stopPeriodicVerification(): void {
  if (periodicTimer !== null) {
    clearInterval(periodicTimer);
    periodicTimer = null;
  }
}

/**
 * Check if periodic verification is currently running.
 */
export function isPeriodicVerificationRunning(): boolean {
  return periodicTimer !== null;
}
