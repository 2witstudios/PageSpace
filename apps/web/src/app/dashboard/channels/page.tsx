'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import ChannelsCenterList from '@/components/inbox/ChannelsCenterList';

function ChannelsPageContent() {
  const searchParams = useSearchParams();
  const driveId = searchParams.get('driveId') ?? undefined;
  return <ChannelsCenterList driveId={driveId} />;
}

export default function ChannelsPage() {
  return (
    <Suspense fallback={null}>
      <ChannelsPageContent />
    </Suspense>
  );
}
