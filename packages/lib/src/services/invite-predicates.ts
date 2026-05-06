/**
 * Pure predicates for pending-invite state checks.
 *
 * These functions are side-effect-free and accept `now` as an injected
 * argument so they can be tested deterministically without freezing the
 * system clock.
 *
 * @module @pagespace/lib/services/invite-predicates
 */

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export const isInviteExpired = ({
  expiresAt,
  now,
}: {
  expiresAt: Date;
  now: Date;
}): boolean => now.getTime() >= expiresAt.getTime();

export const isInviteConsumed = ({
  consumedAt,
}: {
  consumedAt: Date | null;
}): boolean => consumedAt !== null;

export const isEmailMatchingInvite = ({
  inviteEmail,
  userEmail,
}: {
  inviteEmail: string;
  userEmail: string;
}): boolean => normalizeEmail(inviteEmail) === normalizeEmail(userEmail);
