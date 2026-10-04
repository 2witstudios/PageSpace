/**
 * The sign-in seam of verified-domain auto-join (SEC-1). Every path that creates an account or verifies
 * an address calls this once the account's email state is final: OAuth sign-in and signup (Google, Apple),
 * magic-link verification, passkey signup, and email verification.
 *
 * It never throws and never blocks a sign-in: a refusal (no seat, a lapsed org) is audited by lib and the
 * person simply is not added. Dark while ORGS_ENABLED is off (lib returns before any IO).
 */
import { autoJoinVerifiedDomainOrg } from '@pagespace/lib/organizations/domains';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { defaultSeatBilling } from '@/lib/org-billing/seat-billing';

export async function autoJoinVerifiedDomainAfterSignIn(userId: string): Promise<void> {
  try {
    await autoJoinVerifiedDomainOrg({ userId, now: new Date(), seatBilling: defaultSeatBilling() });
  } catch (error) {
    loggers.auth.error('Verified-domain auto-join failed; sign-in continues', error as Error, { userId });
  }
}
