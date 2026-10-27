import { useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useDriveStore } from '@/hooks/useDrive';
import { usePageTree } from '@/hooks/usePageTree';
import { resolveHomeRedirectTarget } from '@/lib/tree/home-redirect';

/**
 * At the exact drive root (/dashboard/[driveId]), replace the URL with the
 * drive's home page when one is set and visible to the user. All decision
 * logic lives in resolveHomeRedirectTarget; this hook is plumbing only.
 *
 * isHomeRedirectPending suppresses the GlobalAssistantView flash while the
 * tree loads or the replace is in flight. A home page absent from the tree
 * (trashed, deleted, or not viewable) resolves to "not pending" — the drive
 * root falls back to its default view with no error.
 */
export function useDriveHomeRedirect(
  driveId: string | undefined,
  activePageId: string | null
): { isHomeRedirectPending: boolean } {
  const pathname = usePathname();
  const router = useRouter();
  const homePageId = useDriveStore((s) =>
    driveId ? s.drives.find((d) => d.id === driveId)?.homePageId ?? null : null
  );
  const { tree, isLoading } = usePageTree(driveId);

  const atDriveRoot = !!driveId && !activePageId && pathname === `/dashboard/${driveId}`;
  const target = atDriveRoot && !isLoading ? resolveHomeRedirectTarget(homePageId, tree) : null;

  // Replace at most once per driveId:target while at the drive root; reset on
  // leaving so a deliberate return to the drive root redirects again.
  const replacedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!atDriveRoot) {
      replacedKeyRef.current = null;
      return;
    }
    if (!driveId || !target) return;
    const key = `${driveId}:${target}`;
    if (replacedKeyRef.current === key) return;
    replacedKeyRef.current = key;
    router.replace(`/dashboard/${driveId}/${target}`);
  }, [atDriveRoot, driveId, target, router]);

  const isHomeRedirectPending = atDriveRoot && !!homePageId && (isLoading || !!target);

  return { isHomeRedirectPending };
}
