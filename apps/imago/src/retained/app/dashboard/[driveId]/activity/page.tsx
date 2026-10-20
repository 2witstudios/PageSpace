'use client';

import { Suspense } from 'react';
import { useParams } from '@/retained-adapters/navigation';
import { Skeleton } from '@/retained/components/ui/skeleton';
import { DriveActivityTimeline } from '@/retained/components/activity/DriveActivityTimeline';
import { useIsHome } from '@/ui/frame/drives/home-drive-context';

/** A drive's activity; on Home, the dashboard, the viewer's own across every drive. */
function DriveActivityContent() {
  const params = useParams();
  const driveId = params.driveId as string;
  return <DriveActivityTimeline driveId={useIsHome(driveId) ? null : driveId} />;
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
