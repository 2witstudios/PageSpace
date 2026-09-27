/**
 * GUEST is the drive_members row a redeemed page share link creates. It is an
 * accepted row, but it is not a drive-wide membership: a guest holds exactly the
 * page_permissions grants they were given and nothing the drive hands its
 * members — no rule-4 read of non-private pages, no channel posting, no custom
 * role, no place in member listings, member counts or DM eligibility. Every reader
 * of drive_members that means "is a member" must treat a GUEST row as absent.
 */
export function isGuestRole(role: string | null | undefined): boolean {
  return role === 'GUEST';
}
