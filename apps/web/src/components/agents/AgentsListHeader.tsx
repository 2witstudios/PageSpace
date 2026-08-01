'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import CreateDriveDialog from '@/components/layout/left-sidebar/CreateDriveDialog';
import { useDriveStore } from '@/hooks/useDrive';
import { usePageAgents } from '@/hooks/page-agents/usePageAgents';
import { useUIStore } from '@/stores/useUIStore';
import { useSpawnSession } from './useSpawnSession';
import DrivePickerDialog from './DrivePickerDialog';

/**
 * Header above the Agents console's past-conversations list: gives it a
 * title and the three ways to start something new (a drive, an agent, a
 * session) that today only exist buried in the sidebar or the page-type
 * palette. Drive-scoped, "New Session"/"New Agent" act on this drive
 * directly; on the global console (no `driveId`) they open a drive picker
 * first, since neither creation path has anywhere else to put the result.
 */
export default function AgentsListHeader({ driveId }: { driveId?: string }) {
  const router = useRouter();
  const drives = useDriveStore((state) => state.drives);
  const driveName = driveId ? (drives.find((drive) => drive.id === driveId)?.name ?? null) : null;

  const [createDriveOpen, setCreateDriveOpen] = useState(false);
  const { agentsByDrive } = usePageAgents();
  const { openSpawn, paletteElement } = useSpawnSession(agentsByDrive);
  const openQuickCreate = useUIStore((state) => state.openQuickCreate);

  // Which button opened the picker — decides what happens once a drive is
  // picked. Null means the picker is closed.
  const [pickerFor, setPickerFor] = useState<'session' | 'agent' | null>(null);

  const handleNewSession = () => {
    if (driveId) {
      openSpawn(driveId, driveName);
      return;
    }
    setPickerFor('session');
  };

  const handleNewAgent = () => {
    if (driveId) {
      openQuickCreate(null);
      return;
    }
    setPickerFor('agent');
  };

  const handleDrivePicked = (pickedDriveId: string, pickedDriveName: string) => {
    setPickerFor(null);
    if (pickerFor === 'session') {
      openSpawn(pickedDriveId, pickedDriveName);
      return;
    }
    if (pickerFor === 'agent') {
      // Quick Create resolves its own driveId from the route — unlike
      // spawning a session, there's no override to pass it directly, so
      // land on that drive's Agents page first.
      router.push(`/dashboard/${pickedDriveId}/agents`);
      openQuickCreate(null);
    }
  };

  return (
    <div className="flex items-center justify-between border-b border-border px-4 py-3">
      <h2 className="text-sm font-semibold text-foreground">Agents</h2>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setCreateDriveOpen(true)}>
          <Plus className="h-4 w-4 mr-1" />
          New Drive
        </Button>
        <Button variant="outline" size="sm" onClick={handleNewAgent}>
          <Plus className="h-4 w-4 mr-1" />
          New Agent
        </Button>
        <Button size="sm" onClick={handleNewSession}>
          <Plus className="h-4 w-4 mr-1" />
          New Session
        </Button>
      </div>

      <CreateDriveDialog isOpen={createDriveOpen} setIsOpen={setCreateDriveOpen} />
      {paletteElement}
      <DrivePickerDialog
        open={pickerFor !== null}
        onOpenChange={(open) => !open && setPickerFor(null)}
        onPick={handleDrivePicked}
      />
    </div>
  );
}
