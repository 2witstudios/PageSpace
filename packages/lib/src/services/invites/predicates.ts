const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export const isInviteExpired = ({
  expiresAt,
  now,
}: {
  expiresAt: Date | null;
  now: Date;
}): boolean => expiresAt !== null && now.getTime() >= expiresAt.getTime();

export const isInviteConsumed = ({
  consumedAt,
}: {
  consumedAt: Date | null;
}): boolean => consumedAt !== null;

export const isEmailMatch = ({
  inviteEmail,
  userEmail,
}: {
  inviteEmail: string;
  userEmail: string;
}): boolean => normalizeEmail(inviteEmail) === normalizeEmail(userEmail);

export const isAccountSuspended = ({
  suspendedAt,
}: {
  suspendedAt: Date | null;
}): boolean => suspendedAt !== null;
