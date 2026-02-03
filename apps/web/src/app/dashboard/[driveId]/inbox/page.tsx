'use client';

import { useParams } from 'next/navigation';
import InboxCenterList from '@/components/inbox/InboxCenterList';

export default function DriveInboxPage() {
  const params = useParams();
  const driveId = params.driveId as string;

  return <InboxCenterList driveId={driveId} />;
}
