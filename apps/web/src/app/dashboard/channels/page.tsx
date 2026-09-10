'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import ChannelsCenterList from '@/components/inbox/ChannelsCenterList';
import { isDriveIdShape } from '@/components/tasks/dashboardFiltersPersistence';

function ChannelsPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // `/dashboard/channels?driveId=…` predates the drive focus. It means what
  // `/dashboard/[driveId]/channels` means, and rendering it here would show a
  // drive's list under an "All drives" sidebar, so it goes there instead.
  const rawDriveId = searchParams.get('driveId');
  const legacyDriveId = rawDriveId && isDriveIdShape(rawDriveId) ? rawDriveId : null;
  useEffect(() => {
    if (legacyDriveId) {
      router.replace(`/dashboard/${legacyDriveId}/channels`);
    }
  }, [legacyDriveId, router]);

  if (legacyDriveId) return null;
  return <ChannelsCenterList />;
}

export default function ChannelsPage() {
  return (
    <Suspense fallback={null}>
      <ChannelsPageContent />
    </Suspense>
  );
}
