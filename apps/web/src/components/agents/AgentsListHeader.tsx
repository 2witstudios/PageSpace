'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { useSWRConfig } from 'swr';

import { Button } from '@/components/ui/button';
import CreateDriveDialog from '@/components/layout/left-sidebar/CreateDriveDialog';
import { useAuth } from '@/hooks/useAuth';
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
 *
 * "New Session" is hidden for non-admins, mirroring `AgentsSidebar`'s own
 * `canSpawn` gate — sandboxes are admin-only everywhere else in this
 * console, and showing the button here would be the one place that UI
 * promise doesn't hold. "New Drive" and "New Agent" are ordinary
 * page/drive creation, open to anyone with the underlying permission, same
 * as `DrivesBrowser` and the Quick Create palette.
 */
export default function AgentsListHeader({ driveId }: { driveId?: string }) {
  const router = useRouter();
  const { user, isLoading: authLoading } = useAuth();
  const canSpawn = user?.role === 'admin' && !authLoading;
  const drives = useDriveStore((state) => state.drives);
  const driveName = driveId ? (drives.find((drive) => drive.id === driveId)?.name ?? null) : null;

  const [createDriveOpen, setCreateDriveOpen] = useState(false);
  const { agentsByDrive } = usePageAgents(undefined, { enabled: canSpawn });
  const { mutate } = useSWRConfig();
  const { openSpawn, paletteElement } = useSpawnSession(agentsByDrive, () => {
    // Broad match: the sidebar's sessions key is drive-scoped or global
    // depending on ITS OWN route, and this header doesn't know which is
    // mounted alongside it — without this, a session spawned from here only
    // shows up in the sidebar after its 20s poll.
    void mutate((key) => typeof key === 'string' && key.startsWith('/api/agent-sessions'));
  });
  const openQuickCreate = useUIStore((state) => state.openQuickCreate);

  // Which button opened the picker — decides what happens once a drive is
  // picked. Null means the picker is closed.
  const [pickerFor, setPickerFor] = useState<'session' | 'agent' | null>(null);

  // Quick Create resolves its own driveId from the route (`useParams()`),
  // not from anything passed here — so a global-page "New Agent" must wait
  // for THIS component's own `driveId` prop to reflect the just-navigated
  // route before opening it, rather than opening in the same tick as
  // `router.push` and racing the navigation.
  const [pendingAgentDriveId, setPendingAgentDriveId] = useState<string | null>(null);
  useEffect(() => {
    if (pendingAgentDriveId && driveId === pendingAgentDriveId) {
      openQuickCreate(null);
      setPendingAgentDriveId(null);
    }
  }, [pendingAgentDriveId, driveId, openQuickCreate]);

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
      setPendingAgentDriveId(pickedDriveId);
      router.push(`/dashboard/${pickedDriveId}/agents`);
    }
  };

  return (
    <div className="flex items-center justify-between border-b border-border px-4 py-3">
      <h2 className="text-sm font-semibold text-foreground">Agents</h2>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setCreateDriveOpen(true)}>
          <Plus className="h-4 w-4" />
          <span className="hidden sm:inline ml-1">New Drive</span>
        </Button>
        <Button variant="outline" size="sm" onClick={handleNewAgent}>
          <Plus className="h-4 w-4" />
          <span className="hidden sm:inline ml-1">New Agent</span>
        </Button>
        {canSpawn && (
          <Button size="sm" onClick={handleNewSession}>
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline ml-1">New Session</span>
          </Button>
        )}
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
