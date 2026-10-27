"use client";

import { useEffect } from 'react';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import { Home, FileQuestion } from 'lucide-react';
import { patch } from '@/lib/auth/auth-fetch';
import { Button } from '@/components/ui/button';
import { useDriveStore } from '@/hooks/useDrive';
import { usePublishStatusStore } from '@/stores/usePublishStatusStore';

interface CanvasHomePageSettingsSectionProps {
  pageId: string;
}

/**
 * Home / 404 page category: lets this page be assigned as the drive's home
 * page or default 404 page. Reuses the exact same
 * `patch('/api/drives/:driveId', { homePageId | notFoundPageId })` +
 * `useDriveStore().updateDrive` calls already used by the sidebar's "Set as
 * home page" context-menu action and the domains settings page's 404-page
 * picker, rather than inventing a new mechanism.
 */
export function CanvasHomePageSettingsSection({ pageId }: CanvasHomePageSettingsSectionProps) {
  const params = useParams<{ driveId?: string }>();
  const driveId = params?.driveId;

  const fetchDrives = useDriveStore((state) => state.fetchDrives);
  const updateDriveInStore = useDriveStore((state) => state.updateDrive);
  const drive = useDriveStore((state) => state.drives.find((d) => d.id === driveId));

  useEffect(() => {
    fetchDrives();
  }, [fetchDrives]);

  const canManageDrive = !!drive && (drive.isOwned || drive.role === 'ADMIN');
  const isHomePage = drive?.homePageId === pageId;
  const isNotFoundPage = drive?.notFoundPageId === pageId;

  const handleHomeToggle = async () => {
    if (!driveId) return;
    const next = isHomePage ? null : pageId;
    const toastId = toast.loading(next ? 'Setting home page…' : 'Removing home page…');
    try {
      await patch(`/api/drives/${driveId}`, { homePageId: next });
      updateDriveInStore(driveId, { homePageId: next });
      // The page's published URL depends on whether it's the drive's home
      // page (served at the root vs its slug — see the publish GET route),
      // so the header's cached PublishControls status is now stale: refetch
      // rather than leaving it showing (and letting Copy link copy) a URL
      // that no longer matches what's actually being served. `force: true`
      // because another consumer's mount-time fetch may still be in flight
      // (reading the row from before this mutation) — reusing it here would
      // apply that stale read once it resolves instead of a fresh one.
      usePublishStatusStore.getState().fetchStatus(pageId, { force: true });
      toast.success(next ? 'Home page set.' : 'Home page removed.', { id: toastId });
    } catch {
      toast.error('Error updating home page.', { id: toastId });
    }
  };

  const handleNotFoundToggle = async () => {
    if (!driveId) return;
    const next = isNotFoundPage ? null : pageId;
    const toastId = toast.loading(next ? 'Setting 404 page…' : 'Removing 404 page…');
    try {
      await patch(`/api/drives/${driveId}`, { notFoundPageId: next });
      updateDriveInStore(driveId, { notFoundPageId: next });
      toast.success(next ? '404 page set.' : '404 page removed.', { id: toastId });
    } catch {
      toast.error('Error updating 404 page.', { id: toastId });
    }
  };

  if (!drive) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  if (!canManageDrive) {
    return (
      <p className="text-sm text-muted-foreground">
        Only the drive owner or an admin can assign the home or 404 page.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 min-w-0">
          <Home className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          <div className="min-w-0">
            <div className="font-medium text-sm">Home page</div>
            <p className="text-xs text-muted-foreground">
              {isHomePage ? 'This is the drive\'s landing page.' : 'The page people land on when they enter this drive.'}
            </p>
          </div>
        </div>
        <Button variant={isHomePage ? 'outline' : 'default'} size="sm" onClick={handleHomeToggle}>
          {isHomePage ? 'Remove' : 'Set as home page'}
        </Button>
      </div>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 min-w-0">
          <FileQuestion className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          <div className="min-w-0">
            <div className="font-medium text-sm">404 page</div>
            <p className="text-xs text-muted-foreground">
              {isNotFoundPage ? 'Shown for any unknown URL on this drive\'s published site.' : 'Falls back to the generic branded 404 page.'}
            </p>
          </div>
        </div>
        <Button variant={isNotFoundPage ? 'outline' : 'default'} size="sm" onClick={handleNotFoundToggle}>
          {isNotFoundPage ? 'Remove' : 'Set as 404 page'}
        </Button>
      </div>
    </div>
  );
}
