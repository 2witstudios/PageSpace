'use client';

import { useEffect, Suspense } from 'react';
import { useParams } from 'next/navigation';
import { Hash } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { useDriveStore } from '@/hooks/useDrive';

function DriveInboxContent() {
  const params = useParams();
  const driveId = params.driveId as string;
  const { drives, isLoading, fetchDrives } = useDriveStore();

  useEffect(() => {
    fetchDrives();
  }, [fetchDrives]);

  const drive = drives.find(d => d.id === driveId);

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Skeleton className="h-12 w-48" />
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
    <div className="h-full flex items-center justify-center">
      <div className="text-center -mt-20">
        <Hash className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
        <h2 className="text-xl font-semibold mb-2">{drive.name} Channels</h2>
        <p className="text-muted-foreground">
          Select a channel from the sidebar to view messages
        </p>
      </div>
    </div>
  );
}

export default function DriveInboxPage() {
  return (
    <Suspense
      fallback={
        <div className="h-full flex items-center justify-center">
          <Skeleton className="h-12 w-48" />
        </div>
      }
    >
      <DriveInboxContent />
    </Suspense>
  );
}
