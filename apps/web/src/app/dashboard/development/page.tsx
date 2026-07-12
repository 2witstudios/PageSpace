'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDriveStore } from '@/hooks/useDrive';
import { resolveActiveDriveId } from '@/lib/development/resolve-active-drive';

/**
 * The driveless entry to the Development surface. NOT a second implementation of
 * the surface — it resolves the active drive and forwards to the one real route
 * tree at `/dashboard/[driveId]/development`, so there is exactly one page
 * component per view (deliberately unlike Channels/Tasks/Calendar, which each
 * ship a driveless `?driveId=` twin of their drive-scoped page).
 *
 * A client redirect rather than the server's `redirect()`: "the drive you were
 * last in" is `currentDriveId` in the persisted (localStorage) drive store, so
 * the server has nothing to resolve it from.
 *
 * `currentDriveId` is read ONCE, at first render. DriveSwitcher clears it on
 * mount whenever the URL names no drive — which this route, by definition, does
 * not — so reading it in an effect would race that clear and lose the very
 * answer we came for.
 */
export default function DevelopmentRedirectPage() {
  const router = useRouter();
  const drives = useDriveStore((state) => state.drives);
  const fetchDrives = useDriveStore((state) => state.fetchDrives);
  const [lastVisitedDriveId] = useState(() => useDriveStore.getState().currentDriveId);
  const [drivesSettled, setDrivesSettled] = useState(false);

  // Gate the redirect on the fetch SETTLING, not on `isLoading` being false:
  // with a cold store, `isLoading` is still false on the first render (the fetch
  // hasn't started), and `drives` is still [] — so redirecting on that render
  // would send anyone with an empty or expired cache to the drive picker even
  // though they have drives. `fetchDrives` no-ops on a warm cache, so this costs
  // a fresh session nothing.
  useEffect(() => {
    let cancelled = false;
    void fetchDrives().finally(() => {
      if (!cancelled) setDrivesSettled(true);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchDrives]);

  useEffect(() => {
    if (!drivesSettled) return;
    const driveId = resolveActiveDriveId(drives, lastVisitedDriveId);
    // No drive to develop in — the drive picker is the only useful destination.
    router.replace(driveId ? `/dashboard/${driveId}/development` : '/dashboard/drives');
  }, [drives, drivesSettled, lastVisitedDriveId, router]);

  return (
    <div className="flex h-full items-center justify-center">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      <span className="sr-only">Opening Development…</span>
    </div>
  );
}
