/**
 * Which org a screen belongs to (SEAT-9: "Owner and Admins see a reactivate banner on every org
 * surface; members see a read-only notice"). An org surface is any /orgs/[orgId] page, and any
 * page of an open org-owned drive under /dashboard/[driveId]. Pure, so the app shell's one banner
 * placement decides where it shows from the route alone.
 */
export function orgIdForSurface(
  pathname: string | null | undefined,
  drives: readonly { id: string; orgId?: string | null }[],
): string | null {
  if (!pathname) return null;
  const [first, second] = pathname.split('/').filter(Boolean);
  if (!second) return null;
  if (first === 'orgs') return second;
  if (first === 'dashboard') return drives.find((d) => d.id === second)?.orgId ?? null;
  return null;
}
