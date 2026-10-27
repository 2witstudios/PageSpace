'use client';

import { Suspense } from 'react';
import { useParams } from 'next/navigation';
import { Skeleton } from '@/components/ui/skeleton';
import { TasksDashboard } from '@/components/tasks';

function DriveTasksContent() {
  const params = useParams();
  return <TasksDashboard driveId={params.driveId as string} />;
}

export default function DriveTasksPage() {
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
      <DriveTasksContent />
    </Suspense>
  );
}
