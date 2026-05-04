'use client';

import { useParams } from 'next/navigation';
import ChannelsCenterList from '@/components/inbox/ChannelsCenterList';

export default function DriveChannelsPage() {
  const params = useParams();
  const driveId = params.driveId as string;

  return <ChannelsCenterList driveId={driveId} />;
}
