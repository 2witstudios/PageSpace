'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { DriveMembers } from '@/components/members/DriveMembers';
import { useDriveStore } from '@/hooks/useDrive';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Settings } from 'lucide-react';

export default function MembersPage() {
  const params = useParams();
  const router = useRouter();
  const driveId = params.driveId as string;
  const { drives, isLoading, fetchDrives } = useDriveStore();
  
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
        <div className="mb-6 flex justify-between items-start">
          <div>
            <h1 className="text-2xl font-bold">Drive Members</h1>
            <p className="text-gray-600 dark:text-gray-400 mt-1">
              Manage who has access to {drive.name}
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => router.push(`/dashboard/${driveId}/settings`)}
          >
            <Settings className="w-4 h-4 mr-2" />
            Drive Settings
          </Button>
        </div>
        
        <DriveMembers driveId={driveId} />
      </div>
    </div>
  );
}