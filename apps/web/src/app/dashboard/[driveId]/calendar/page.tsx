'use client';

import { useEffect, Suspense } from 'react';
import { useParams } from 'next/navigation';
import { Skeleton } from '@/components/ui/skeleton';
import { useDriveStore } from '@/hooks/useDrive';
import { CalendarView } from '@/components/calendar';

function DriveCalendarContent() {
  const params = useParams();
  const driveId = params.driveId as string;
  const { drives, isLoading, fetchDrives } = useDriveStore();

  useEffect(() => {
    fetchDrives();
  }, [fetchDrives]);

  const drive = drives.find(d => d.id === driveId);

  if (isLoading) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="p-4 space-y-4">
          <div className="flex items-center justify-between">
            <Skeleton className="h-8 w-48" />
            <div className="flex gap-2">
              <Skeleton className="h-10 w-24" />
              <Skeleton className="h-10 w-24" />
            </div>
          </div>
          <Skeleton className="h-[600px]" />
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
    <div className="h-full flex flex-col">
      <CalendarView
        context="drive"
        driveId={driveId}
        driveName={drive.name}
      />
    </div>
  );
}

export default function DriveCalendarPage() {
  return (
    <Suspense
      fallback={
        <div className="h-full overflow-y-auto">
          <div className="p-4 space-y-4">
            <div className="flex items-center justify-between">
              <Skeleton className="h-8 w-48" />
              <div className="flex gap-2">
                <Skeleton className="h-10 w-24" />
                <Skeleton className="h-10 w-24" />
              </div>
            </div>
            <Skeleton className="h-[600px]" />
          </div>
        </div>
      }
    >
      <DriveCalendarContent />
    </Suspense>
  );
}
