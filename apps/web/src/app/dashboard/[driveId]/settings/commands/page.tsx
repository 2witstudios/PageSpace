'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ChevronLeft, SlashSquare, Info } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useDriveStore } from '@/hooks/useDrive';
import { canManageDriveCommands } from '@/lib/commands/command-gating';
import { DRIVE_READONLY_NOTICE } from '@/lib/commands/command-form-core';
import { CommandsSettings } from '@/components/commands/CommandsSettings';

export default function DriveCommandsSettingsPage() {
  const params = useParams();
  const router = useRouter();
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
      <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-10 max-w-2xl">
        <Skeleton className="h-8 w-48 mb-2" />
        <Skeleton className="h-4 w-64 mb-8" />
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
    <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-10 max-w-2xl space-y-6">
      <div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push(`/dashboard/${driveId}/settings`)}
          className="mb-4"
        >
          <ChevronLeft className="h-4 w-4 mr-1" />
          Back to Settings
        </Button>
        <h1 className="text-3xl font-bold mb-2 flex items-center gap-2">
          <SlashSquare className="h-8 w-8" />
          Commands
        </h1>
        <p className="text-muted-foreground">
          Slash commands available to everyone in {drive.name}.
        </p>
      </div>

      {!canManage && (
        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription>{DRIVE_READONLY_NOTICE}</AlertDescription>
        </Alert>
      )}

      <CommandsSettings scope="drive" driveId={driveId} canManage={canManage} />
    </div>
  );
}
