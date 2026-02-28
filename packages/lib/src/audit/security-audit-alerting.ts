/**
 * Security Audit Chain Verification Alerting (#544)
 *
 * Provides:
 * - Alert callback on chain verification failure
 * - Periodic cron-style verification scheduler
 * - Configurable alert handler for integration with external systems
 */

import {
  verifySecurityAuditChain,
  type SecurityChainVerificationResult,
  type VerifySecurityChainOptions,
} from './security-audit-chain-verifier';

/**
 * Alert payload sent when chain verification detects an issue.
 */
export interface ChainVerificationAlert {
  result: SecurityChainVerificationResult;
  triggeredAt: Date;
  source: 'periodic' | 'manual';
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
      console.error('[SecurityAuditAlerting] Alert handler failed:', error);
    }
  }

  return result;
}

let periodicTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start periodic chain verification on an interval.
 * Replaces any previously running scheduler.
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
    verifyAndAlert('periodic', options).catch((error) => {
      console.error('[SecurityAuditAlerting] Periodic verification failed:', error);
    });
  }, intervalMs);

  // Don't keep the process alive just for verification
  if (periodicTimer && typeof periodicTimer === 'object' && 'unref' in periodicTimer) {
    periodicTimer.unref();
  }
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
