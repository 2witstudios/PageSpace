/**
 * `buildDeniedOutcome` — the audit outcome for a refused grant (ADR 0004 §5,
 * F16; G1c R14). The verifier's refusal toward the caller is one constant
 * shape; the audit is where the reason lives, and for `account_not_active` the
 * status that caused it (`revoked`, `needs_reauth`, `deleted`) belongs there
 * too. Every other reason, and an unknown account, records null so a status is
 * never attached to a refusal it did not cause. Pure.
 */
import type { AccountStatus } from '@pagespace/db/schema/agent-accounts';
import type { AuditOutcome } from './audit';
import type { GrantDenyReason } from './grant';

export function buildDeniedOutcome({
  reason,
  accountStatus,
}: {
  readonly reason: GrantDenyReason;
  readonly accountStatus: AccountStatus | null;
}): Extract<AuditOutcome, { readonly kind: 'denied' }> {
  return { kind: 'denied', reason, accountStatus: reason === 'account_not_active' ? accountStatus : null };
}
