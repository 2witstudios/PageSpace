'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from '@/retained-adapters/navigation';
import { Button } from '@/retained/components/ui/button';
import { Skeleton } from '@/retained/components/ui/skeleton';
import { Shield } from 'lucide-react';
import { useDriveStore } from '@/retained/hooks/useDrive';
import { DriveAISettings } from '@/retained/components/settings/DriveAISettings';
import { SettingsScreen } from '@/ui/settings/settings-screen/settings-screen';

export default function ContextSettingsPage() {
  const params = useParams();
  const router = useRouter();
  const driveId = params.driveId as string;
  const drives = useDriveStore((state) => state.drives);
  const isLoading = useDriveStore((state) => state.isLoading);
  const fetchDrives = useDriveStore((state) => state.fetchDrives);

  useEffect(() => {
    fetchDrives();
  }, [fetchDrives]);

  const drive = drives.find((d) => d.id === driveId);
  const canManage = drive?.isOwned || drive?.role === 'ADMIN';

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-10 max-w-2xl">
        <Skeleton className="h-8 w-48 mb-2" />
        <Skeleton className="h-4 w-64 mb-8" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!drive || !canManage) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <Shield className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold mb-2">Access Denied</h2>
          <p className="text-muted-foreground">Only drive owners and admins can access settings.</p>
          <Button
            variant="outline"
            className="mt-4"
            onClick={() => router.push(`/dashboard/${driveId}`)}
          >
            Go Back
          </Button>
        </div>
      </div>
    );
  }

  return (
    <SettingsScreen
      title="Drive context"
      lede={`Workspace memory the AI reads in every conversation in ${drive.name} — like a CLAUDE.md for the drive. Agents can add to it as they learn.`}
    >
      <DriveAISettings driveId={driveId} />
    </SettingsScreen>
  );
}
