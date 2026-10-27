'use client';

import { useParams } from 'next/navigation';
import ChannelsCenterList from '@/components/inbox/ChannelsCenterList';

export default function DriveChannelsPage() {
  const params = useParams();
  return <ChannelsCenterList driveId={params.driveId as string} />;
}
