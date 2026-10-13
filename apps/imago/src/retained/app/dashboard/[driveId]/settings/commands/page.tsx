'use client';

import { useEffect } from 'react';
import { useParams } from '@/retained-adapters/navigation';
import { Skeleton } from '@/retained/components/ui/skeleton';
import { Alert, AlertDescription } from '@/retained/components/ui/alert';
import { Info } from 'lucide-react';
import { useAuth } from '@/retained/hooks/useAuth';
import { useDriveStore } from '@/retained/hooks/useDrive';
import { canManageDriveCommands } from '@/retained/lib/commands/command-gating';
import { DRIVE_READONLY_NOTICE } from '@/retained/lib/commands/command-form-core';
import { CommandsSettings } from '@/retained/components/commands/CommandsSettings';
import { SettingsScreen } from '@/ui/settings/settings-screen/settings-screen';

export default function DriveCommandsSettingsPage() {
  const params = useParams();
  const driveId = params.driveId as string;
  const { user, isLoading: authLoading } = useAuth();
  const drives = useDriveStore((state) => state.drives);
  const isLoading = useDriveStore((state) => state.isLoading);
  const fetchDrives = useDriveStore((state) => state.fetchDrives);

  useEffect(() => {
    fetchDrives();
  }, [fetchDrives]);

  const drive = drives.find((d) => d.id === driveId);
  // Every member can read this route; owners/admins can author (spec §4.1).
  const canManage = canManageDriveCommands(drive);

  if (authLoading || isLoading || !user) {
    return (
      <div className="container mx-auto max-w-2xl px-4 py-10 sm:px-6 lg:px-10">
        <Skeleton className="mb-2 h-8 w-48" />
        <Skeleton className="mb-8 h-4 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!drive) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-muted-foreground">Drive not found</p>
      </div>
    );
  }

  return (
    <SettingsScreen
      title="Commands"
      lede={
        <>
          Slash commands available to everyone in {drive.name}. Type <code>/</code> in any chat to use them.
        </>
      }
    >
      {!canManage && (
        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription>{DRIVE_READONLY_NOTICE}</AlertDescription>
        </Alert>
      )}

      <CommandsSettings scope="drive" driveId={driveId} canManage={canManage} />
    </SettingsScreen>
  );
}
