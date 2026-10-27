'use client';

import { Suspense } from 'react';
import ChannelsCenterList from '@/components/inbox/ChannelsCenterList';
import { useLegacyFocusRedirect } from '@/lib/dashboard/focus';

function ChannelsPageContent() {
  // `/dashboard/channels?driveId=…` predates the drive focus. It means what
  // `/dashboard/[driveId]/channels` means, and rendering it here would show a
  // drive's list under an "All drives" sidebar, so it goes there instead.
  const legacyHref = useLegacyFocusRedirect();
  if (legacyHref) return null;
  return <ChannelsCenterList />;
}

export default function ChannelsPage() {
  return (
    <Suspense fallback={null}>
      <ChannelsPageContent />
    </Suspense>
  );
}
