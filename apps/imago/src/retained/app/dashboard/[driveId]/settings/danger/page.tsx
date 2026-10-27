'use client';

import { useEffect } from 'react';
import { useParams } from '@/retained-adapters/navigation';
import { Skeleton } from '@/retained/components/ui/skeleton';
import { Shield } from 'lucide-react';
import { useDriveStore } from '@/retained/hooks/useDrive';
import { DriveDeleteSection } from '@/retained/components/settings/DriveDeleteSection';
import { homeDriveActionError } from '@pagespace/lib/services/drive-guards';
import { SettingsScreen, SettingsSection } from '@/ui/settings/settings-screen/settings-screen';

export default function DangerZonePage() {
  const params = useParams();
  const driveId = params.driveId as string;
  const drives = useDriveStore((state) => state.drives);
  const isLoading = useDriveStore((state) => state.isLoading);
  const fetchDrives = useDriveStore((state) => state.fetchDrives);

  useEffect(() => {
    fetchDrives();
  }, [fetchDrives]);

  const drive = drives.find((d) => d.id === driveId);

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-10 max-w-2xl">
        <Skeleton className="h-8 w-48 mb-2" />
        <Skeleton className="h-4 w-64 mb-8" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  // Only the owner sees this screen, and the Home drive can never be trashed, so it is refused here too.
  if (!drive || !drive.isOwned || homeDriveActionError(drive, 'trash') !== null) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <Shield className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold mb-2">Access Denied</h2>
          <p className="text-muted-foreground">Only the drive owner can access this section.</p>
        </div>
      </div>
    );
  }

  return (
    <SettingsScreen
      title="Danger zone"
      lede="Irreversible actions for this drive. Only the drive lead sees this page."
    >
      <SettingsSection title={`Delete ${drive.name}`}>
        <DriveDeleteSection driveId={driveId} driveName={drive.name} />
      </SettingsSection>
    </SettingsScreen>
  );
}
