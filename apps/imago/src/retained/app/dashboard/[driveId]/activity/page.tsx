'use client';

import { Suspense } from 'react';
import { useParams } from '@/retained-adapters/navigation';
import { Skeleton } from '@/retained/components/ui/skeleton';
import { DriveActivityTimeline } from '@/retained/components/activity/DriveActivityTimeline';

function DriveActivityContent() {
  const params = useParams();
  const driveId = params.driveId as string;
  return <DriveActivityTimeline driveId={driveId} />;
}

export default function DriveActivityPage() {
  return (
    <Suspense
      fallback={
        <div className="px-4 py-6 sm:px-6">
          <Skeleton className="h-96" />
        </div>
      }
    >
      <DriveActivityContent />
    </Suspense>
  );
}
