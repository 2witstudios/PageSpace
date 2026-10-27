'use client';

import { Suspense } from 'react';
import { useParams } from '@/retained-adapters/navigation';
import { Skeleton } from '@/retained/components/ui/skeleton';
import { DriveActivityTimeline } from '@/retained/components/activity/DriveActivityTimeline';
import { useAllDrives } from '@/ui/frame/drives/use-section-scope';

/** A drive's activity; with Activity switched to All drives, the viewer's own across every drive. */
function DriveActivityContent() {
  const params = useParams();
  const driveId = params.driveId as string;
  const allDrives = useAllDrives('activity', driveId);
  return <DriveActivityTimeline driveId={allDrives ? null : driveId} />;
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
