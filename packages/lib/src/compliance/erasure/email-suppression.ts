/**
 * Email sub-processor suppression on erasure (GDPR Art 17(2), Art 21) — #913.
 *
 * When a user is erased we must tell the email provider (Resend) to suppress
 * the address so no further mail is delivered, and so the provider's own record
 * is reconciled. The decision (whether/what to suppress, normalization) is pure;
 * the actual provider call is a thin, best-effort edge.
 */

import { isValidEmail } from '../../validators/email';
import type { DeploymentMode } from './erasure-plan';

export interface EmailSuppressionEntry {
  email: string;
  reason: 'gdpr_erasure';
  userId: string;
}

export interface EmailSuppressionPlan {
  shouldSuppress: boolean;
  entries: EmailSuppressionEntry[];
}

export interface BuildEmailSuppressionInput {
  email: string;
  userId: string;
  deploymentMode: DeploymentMode;
}

const isCloudLike = (mode: DeploymentMode): boolean => mode === 'cloud' || mode === 'tenant';

export function buildEmailSuppressionPlan(input: BuildEmailSuppressionInput): EmailSuppressionPlan {
  const normalized = input.email.trim().toLowerCase();

  if (!isCloudLike(input.deploymentMode) || !isValidEmail(normalized)) {
    return { shouldSuppress: false, entries: [] };
  }

  return {
    shouldSuppress: true,
    entries: [{ email: normalized, reason: 'gdpr_erasure', userId: input.userId }],
  };
}

// ---------------------------------------------------------------------------
// Edge
// ---------------------------------------------------------------------------

export interface EmailSuppressionClient {
  suppress: (entry: EmailSuppressionEntry) => Promise<void>;
}

export interface EmailSuppressionResult {
  skipped: boolean;
  suppressed: number;
  failed: number;
}

/**
 * Best-effort: iterate the plan's entries and suppress each. A provider failure
 * is counted but never thrown — the right to erasure cannot hinge on Resend's
 * uptime.
 */
export async function syncEmailSuppression(
  input: BuildEmailSuppressionInput,
  client: EmailSuppressionClient
): Promise<EmailSuppressionResult> {
  const plan = buildEmailSuppressionPlan(input);
  if (!plan.shouldSuppress) {
    return { skipped: true, suppressed: 0, failed: 0 };
  }

  let suppressed = 0;
  let failed = 0;
  for (const entry of plan.entries) {
    try {
      await client.suppress(entry);
      suppressed += 1;
    } catch {
      failed += 1;
    }
  }
  return { skipped: false, suppressed, failed };
}
