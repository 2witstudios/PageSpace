'use client';
import { useEffect } from 'react';
import Link from 'next/link';
import { Button } from '@/retained/components/ui/button';
import { useDriveStore } from '@/retained/hooks/useDrive';
import { useUIStore } from '@/retained/stores/useUIStore';
import { RetainedSurface } from './retained-provider';
export function CreateActions({ driveId, messages = false }: { driveId: string | null; messages?: boolean }) {
  const drives = useDriveStore(state => state.drives);
  const fetchDrives = useDriveStore(state => state.fetchDrives);
  useEffect(() => { void fetchDrives(); }, [fetchDrives]);
  const canCreate = drives.find(drive => drive.id === driveId)?.canCreatePages === true;
  return <RetainedSurface fill={false}><div className="flex flex-wrap gap-2 p-2">
    {messages && <Button variant="outline" size="sm" asChild><Link href="/dm/new">New message</Link></Button>}
    {driveId && <Button variant="outline" size="sm" disabled={!canCreate}
      onClick={() => useUIStore.getState().openQuickCreate(null)}>Create page</Button>}
  </div></RetainedSurface>;
}
