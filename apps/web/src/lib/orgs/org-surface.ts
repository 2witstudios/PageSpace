/**
 * Which org a screen belongs to, for the person looking at it (SEAT-9: "Owner and Admins see a
 * reactivate banner on every org surface; members see a read-only notice"). An org surface is any
 * /orgs/[orgId] page, and any page of an open org-owned drive under /dashboard/[driveId] — but only
 * for a MEMBER of that org. A guest on an org drive is not an org member: the org is not theirs to
 * read (GET /api/orgs/[orgId] answers 404 and audits the denial), so their screens have no org.
 * Pure, so the app shell's one banner placement and its realtime listener decide it from the route.
 */
export function orgIdForSurface(
  isMemberOf: (orgId: string) => boolean,
  pathname: string | null | undefined,
  drives: readonly { id: string; orgId?: string | null }[],
): string | null {
  if (!pathname) return null;
  const [first, second] = pathname.split('/').filter(Boolean);
  if (!second) return null;
  const orgId = first === 'orgs' ? second : first === 'dashboard' ? drives.find((d) => d.id === second)?.orgId ?? null : null;
  return orgId && isMemberOf(orgId) ? orgId : null;
}
