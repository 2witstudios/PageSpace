/**
 * Pure description of the erasure pipeline + retry classification.
 *
 * The runner executes these steps in order; this module decides WHICH steps run
 * (deployment-mode dependent), whether a step is fatal (abort + retry) or
 * best-effort (record + continue), and whether a failure should be retried by
 * the durable queue. No I/O here.
 */

export type DeploymentMode = 'cloud' | 'tenant' | 'onprem';

export type ErasureStepId =
  | 'drive-disposition'
  | 'delete-avatar'
  | 'log-account-deletion'
  | 'anonymize-activity-logs'
  | 'purge-ai-usage'
  | 'purge-monitoring'
  | 'revoke-integrations'
  | 'email-suppression'
  | 'ai-provider-erasure'
  | 'security-audit'
  | 'delete-user'
  | 'stripe-customer';

export const ERASURE_STEPS: readonly ErasureStepId[] = [
  'drive-disposition',
  'delete-avatar',
  'log-account-deletion',
  'anonymize-activity-logs',
  'purge-monitoring',
  'revoke-integrations',
  'email-suppression',
  // AI-provider erasure derives the provider list from the user's ai_usage
  // rows, so it MUST run before those rows are purged (else the manifest is
  // always empty and no ZDR/manual-review evidence is recorded).
  'ai-provider-erasure',
  'purge-ai-usage',
  'security-audit',
  'delete-user',
  'stripe-customer',
];

export interface ErasureStep {
  id: ErasureStepId;
  /** Fatal steps abort the run on failure (and let the queue retry). */
  fatal: boolean;
  /** Cloud-only sub-processor steps are skipped on-prem. */
  cloudOnly: boolean;
}

const STEP_DEFS: ErasureStep[] = [
  { id: 'drive-disposition', fatal: true, cloudOnly: false },
  { id: 'delete-avatar', fatal: false, cloudOnly: false },
  { id: 'log-account-deletion', fatal: false, cloudOnly: false },
  { id: 'anonymize-activity-logs', fatal: false, cloudOnly: false },
  { id: 'purge-monitoring', fatal: false, cloudOnly: false },
  { id: 'revoke-integrations', fatal: false, cloudOnly: false },
  { id: 'email-suppression', fatal: false, cloudOnly: true },
  // Must precede purge-ai-usage: it reads the ai_usage rows to learn which
  // providers the user touched.
  { id: 'ai-provider-erasure', fatal: false, cloudOnly: true },
  { id: 'purge-ai-usage', fatal: false, cloudOnly: false },
  { id: 'security-audit', fatal: false, cloudOnly: false },
  // Deleting the user row is the irreversible core — must succeed.
  { id: 'delete-user', fatal: true, cloudOnly: false },
  { id: 'stripe-customer', fatal: false, cloudOnly: true },
];

export interface BuildErasurePlanInput {
  deploymentMode: DeploymentMode;
}

export function buildErasurePlan(input: BuildErasurePlanInput): ErasureStep[] {
  const cloudLike = input.deploymentMode === 'cloud' || input.deploymentMode === 'tenant';
  return STEP_DEFS.filter((step) => (step.cloudOnly ? cloudLike : true));
}

// ---------------------------------------------------------------------------
// Retry classification
// ---------------------------------------------------------------------------

export const MAX_ERASURE_ATTEMPTS = 5;

/** Sentinel an erasure step throws when a multi-member drive blocks deletion. */
export const ERASURE_BLOCKED_PREFIX = 'ERASURE_BLOCKED';

export interface ErasureErrorClassification {
  retryable: boolean;
  terminalReason?: 'blocked';
}

const TRANSIENT_PATTERNS = [
  /econnreset/i,
  /econnrefused/i,
  /etimedout/i,
  /timeout/i,
  /deadlock/i,
  /connection/i,
  /too many connections/i,
  /503/,
  /429/,
];

export function classifyErasureError(error: unknown): ErasureErrorClassification {
  const message = error instanceof Error ? error.message : String(error);

  // A multi-member block is a policy decision, not a transient fault — a human
  // must escalate (force-delete) or transfer ownership. Retrying is pointless.
  if (message.startsWith(ERASURE_BLOCKED_PREFIX)) {
    return { retryable: false, terminalReason: 'blocked' };
  }

  if (TRANSIENT_PATTERNS.some((re) => re.test(message))) {
    return { retryable: true };
  }

  // Unknown errors default to retryable; the attempt cap is the safety net.
  return { retryable: true };
}

/** Combine error class with the attempt cap. */
export function isRetryable(error: unknown, attemptsSoFar: number): boolean {
  if (attemptsSoFar >= MAX_ERASURE_ATTEMPTS) return false;
  return classifyErasureError(error).retryable;
}
