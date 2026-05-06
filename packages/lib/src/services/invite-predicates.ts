// Pure predicates for drive-invite state. No DB, no Date.now(), no I/O —
// callers inject `now` so behavior is deterministic and unit-testable. Email
// comparisons are case- and whitespace-insensitive to match the normalization
// the invite endpoint already applies on lookup.

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
}): boolean =>
  inviteEmail.trim().toLowerCase() === userEmail.trim().toLowerCase();
