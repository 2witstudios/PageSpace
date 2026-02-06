'use client';

import { useEffect, Suspense } from 'react';
import { useParams } from 'next/navigation';
import { Skeleton } from '@/components/ui/skeleton';
import { useDriveStore } from '@/hooks/useDrive';
import { ActivityDashboard } from '@/components/activity';

function DriveActivityContent() {
  const params = useParams();
  const driveId = params.driveId as string;
  const drives = useDriveStore((state) => state.drives);
  const isLoading = useDriveStore((state) => state.isLoading);
  const fetchDrives = useDriveStore((state) => state.fetchDrives);

  useEffect(() => {
    fetchDrives();
  }, [fetchDrives]);

  const drive = drives.find(d => d.id === driveId);

  if (isLoading) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-10 max-w-5xl">
          <div className="space-y-6">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-96" />
          </div>
        </div>
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
    <ActivityDashboard
      context="drive"
      driveId={driveId}
      driveName={drive.name}
    />
  );
}

export default function DriveActivityPage() {
  return (
    <Suspense
      fallback={
        <div className="h-full overflow-y-auto">
          <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-10 max-w-5xl">
            <div className="space-y-6">
              <Skeleton className="h-8 w-48" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-96" />
            </div>
          </div>
        </div>
      }
    >
      <DriveActivityContent />
    </Suspense>
  );
}
