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
  source: 'periodic' | 'manual' | 'preflight';
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
 * @returns The verification result
 */
export async function verifyAndAlert(
  source: 'periodic' | 'manual' = 'manual',
  options?: VerifySecurityChainOptions
): Promise<SecurityChainVerificationResult> {
  const result = await verifySecurityAuditChain(options);

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

  const syntheticResult: SecurityChainVerificationResult = {
    isValid: false,
    totalEntries: details.breakAtIndex + 1,
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
