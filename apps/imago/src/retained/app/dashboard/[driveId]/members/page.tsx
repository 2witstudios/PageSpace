'use client';

import { useParams } from '@/retained-adapters/navigation';
import { useEffect } from 'react';
import { DriveMembers } from '@/retained/components/members/DriveMembers';
import { useDriveStore } from '@/retained/hooks/useDrive';
import { Skeleton } from '@/retained/components/ui/skeleton';

export default function MembersPage() {
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
      <div className="h-full overflow-auto">
        <div className="max-w-6xl mx-auto p-6">
          <Skeleton className="h-8 w-48 mb-2" />
          <Skeleton className="h-4 w-64 mb-6" />
          <Skeleton className="h-96 w-full" />
        </div>
      </div>
    );
  }

  if (!drive) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-gray-500">Drive not found</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-6xl mx-auto p-6">
        <div id="everyone" className="mb-6">
          <h1 className="text-2xl font-bold">Everyone in {drive.name}</h1>
          <p className="text-gray-600 dark:text-gray-400 mt-1">
            People, guests, agents and apps with access to this drive.
          </p>
        </div>

        <DriveMembers driveId={driveId} driveKind={drive.kind} />
      </div>
    </div>
  );
}
