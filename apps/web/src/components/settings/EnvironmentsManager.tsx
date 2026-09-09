'use client';

/**
 * Drive settings → Environments — the list half of the `RolesManager` shape
 * (GA wave 3, leaf 4). Every environment in the drive, one row each; a LOCAL
 * row opens `EnvironmentEditor`, where the machine's status, policy,
 * effective capability, activity and Stop / Revoke live. A Sprite row shows
 * its status only: its knobs are the sidebar's (rebuild, delete).
 *
 * Who sees what is decided by the ROW, not the page: a drive admin reaches
 * this page, but a local environment's toggles belong to the user who
 * enrolled it ([D-6]); the editor renders read-only for everyone else and
 * names the owner. A plain member who owns a machine can open this page
 * too — the drive settings index withholds the link from members, but the
 * account page (Settings → Local environments) links here for their own.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Boxes, Laptop, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useDriveEnvs } from '@/hooks/drive-envs/useDriveEnvs';
import { useAuth } from '@/hooks/useAuth';
import { useSocket } from '@/hooks/useSocket';
import type { DriveEventPayload } from '@/lib/websocket';
import type { DriveEnvDTO } from '@pagespace/lib/drive-envs/env-contract';
import { EnvironmentEditor } from './EnvironmentEditor';

interface EnvironmentsManagerProps {
  driveId: string;
  /** Drive owner or admin — may Revoke (delete) any environment; never drives one. */
  canAdminister: boolean;
  /** Open this env's editor on mount (the account page links here with `?env=`). */
  initialEnvId?: string | null;
}

function statusBadge(env: DriveEnvDTO): { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' } {
  if (env.substrate === 'local') {
    if (!env.enrolled) return { label: 'Awaiting enrollment', variant: 'outline' };
    if (env.paused) return { label: 'Stopped', variant: 'destructive' };
    if (env.status === 'connected') return { label: 'Connected', variant: 'default' };
    if (env.status === 'connecting') return { label: 'Connecting', variant: 'outline' };
    return { label: 'Not connected', variant: 'secondary' };
  }
  if (env.status === 'running') return { label: 'Running', variant: 'default' };
  if (env.status === 'stopped') return { label: 'Stopped', variant: 'secondary' };
  return { label: 'Not started', variant: 'outline' };
}

export function EnvironmentsManager({ driveId, canAdminister, initialEnvId = null }: EnvironmentsManagerProps) {
  const { envs, isLoading, error, mutate } = useDriveEnvs(driveId);
  const { user } = useAuth();
  const viewerId = typeof user?.id === 'string' ? user.id : null;
  const [editingId, setEditingId] = useState<string | null>(initialEnvId);
  const socket = useSocket();

  // The listing re-reads on the drive's own event, the way roles do.
  const handleDriveUpdated = useCallback(
    (event: DriveEventPayload) => {
      if (event.driveId === driveId) mutate();
    },
    [driveId, mutate],
  );
  useEffect(() => {
    if (!socket) return;
    socket.on('drive:updated', handleDriveUpdated);
    return () => {
      socket.off('drive:updated', handleDriveUpdated);
    };
  }, [socket, handleDriveUpdated]);

  const editing = useMemo(() => envs.find((env) => env.id === editingId && env.substrate === 'local'), [envs, editingId]);

  if (isLoading && envs.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Environments</CardTitle>
          <CardDescription>Loading environments...</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex justify-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (editing && editing.substrate === 'local') {
    return (
      <EnvironmentEditor
        driveId={driveId}
        env={editing}
        viewerId={viewerId}
        canAdminister={canAdminister}
        onChanged={mutate}
        onBack={() => setEditingId(null)}
        onRevoked={() => {
          setEditingId(null);
          mutate();
        }}
      />
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Environments</CardTitle>
        <CardDescription>Where this drive&apos;s sessions run. A local environment is someone&apos;s own computer; only its owner can change what it may run or stop it.</CardDescription>
      </CardHeader>
      <CardContent>
        {error != null && (
          <div className="mb-3 flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm text-muted-foreground">
            <span>Could not load environments</span>
            <Button variant="outline" size="sm" onClick={mutate}>
              Retry
            </Button>
          </div>
        )}
        <div className="space-y-2">
          {envs.length === 0 ? (
            <div className="text-center py-8 border border-dashed border-border rounded-lg">
              <p className="text-muted-foreground">No environments yet. Create one from the sidebar&apos;s New session flow.</p>
            </div>
          ) : (
            envs.map((env) => {
              const badge = statusBadge(env);
              const isLocal = env.substrate === 'local';
              const isMine = isLocal && viewerId !== null && env.ownerId === viewerId;
              return (
                <div key={env.id} data-testid={`env-row-${env.id}`} className="flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-muted/50 transition-colors">
                  {isLocal ? <Laptop className="w-4 h-4 text-muted-foreground" aria-label="Local environment" role="img" /> : <Boxes className="w-4 h-4 text-muted-foreground" aria-hidden="true" />}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium truncate">{env.name}</span>
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                      {isMine && (
                        <Badge variant="outline" className="text-xs">
                          Your machine
                        </Badge>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground truncate">
                      {isLocal ? `On ${env.label} · PageSpace may: ${env.serverPolicy.ops.length === 0 ? 'nothing yet' : env.serverPolicy.ops.map((op) => ({ exec: 'run commands', fs_read: 'read files', fs_write: 'write files', pty_open: 'open a terminal' })[op]).join(', ')}` : 'Cloud sandbox'}
                    </p>
                  </div>
                  {isLocal && (
                    <Button variant="ghost" size="icon" aria-label={`Open ${env.name}`} onClick={() => setEditingId(env.id)}>
                      <Pencil className="w-4 h-4" />
                    </Button>
                  )}
                </div>
              );
            })
          )}
        </div>
      </CardContent>
    </Card>
  );
}
