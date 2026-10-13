'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/retained/components/ui/alert-dialog';
import { del, post } from '@/retained/lib/auth/auth-fetch';
import { useDriveEnvApp, type PublishedAppStatus } from '@/retained/hooks/drive-envs/useDriveEnvApp';
import { useEditingSession } from '@/retained/stores/useEditingSession';
import { hostOf } from './agents-pane.model';

/** Status copy for the card. Covers every status the hosting row can hold. */
export const appStatusLabel = (status: PublishedAppStatus): string => {
  const copy: Record<PublishedAppStatus, string> = {
    provisioning: 'Provisioning…',
    building: 'Building…',
    deploying: 'Deploying…',
    running: 'Live',
    stopped: 'Stopped',
    parked: 'Paused',
    destroying: 'Unpublishing…',
    failed: 'Failed',
  };
  return copy[status] ?? status;
};

/** The tier line. The funding source is withheld until the org/wallet branch lands (needs-api). */
export const tierLabel = (tier: 'metered' | 'dedicated'): string =>
  tier === 'metered' ? 'Tier: Metered (pay per awake time)' : 'Tier: Dedicated (always on)';

const actionClass =
  'h-6 rounded-md border border-hairline bg-transparent px-2 text-xs text-ink hover:bg-fill disabled:opacity-50';

/**
 * The published app of one environment, as a card under that environment's sessions
 * (C-Drive-Agents). Stop and Unpublish reuse the environment's app endpoints and are
 * offered only to people who may manage the drive; the server stays the authority.
 */
export function PublishedAppCard({
  driveId,
  envId,
  envName,
  canManage,
}: {
  readonly driveId: string;
  readonly envId: string;
  readonly envName: string;
  readonly canManage: boolean;
}) {
  const { app, mutate } = useDriveEnvApp(driveId, envId);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  useEditingSession(`agents-pane-unpublish-${envId}`, confirming, 'form', {
    componentName: 'PublishedAppCard.unpublishDialog',
  });

  if (!app) return null;

  const path = `/api/drives/${encodeURIComponent(driveId)}/envs/${encodeURIComponent(envId)}/app`;

  const stop = async () => {
    setBusy(true);
    try {
      await post(`${path}/actions`, { action: 'stop' });
    } catch (error) {
      toast.error('Could not stop the app', { description: error instanceof Error ? error.message : 'Please try again.' });
    } finally {
      setBusy(false);
      mutate();
    }
  };

  const unpublish = async () => {
    setBusy(true);
    try {
      await del(path);
      toast.success(`Unpublished “${envName}”`);
    } catch (error) {
      toast.error('Could not unpublish this app', { description: error instanceof Error ? error.message : 'Please try again.' });
    } finally {
      setBusy(false);
      setConfirming(false);
      mutate();
    }
  };

  return (
    <div role="group" aria-label="Published app" className="mx-1 mt-1 flex flex-col gap-2 rounded-lg border border-hairline p-3 text-xs">
      <div className="flex items-center gap-2">
        <span className="flex-1 font-semibold text-ink">Published app</span>
        <span className="text-status-success">{appStatusLabel(app.status)}</span>
      </div>
      <a href={app.url} target="_blank" rel="noreferrer" className="truncate font-mono text-ink no-underline hover:underline">
        {hostOf(app.url)}
      </a>
      <span className="text-ink-muted">{tierLabel(app.tier)}</span>
      {canManage ? (
        <div className="flex flex-wrap gap-2">
          {app.status === 'running' ? (
            <button type="button" className={actionClass} disabled={busy} onClick={() => void stop()}>
              Stop
            </button>
          ) : null}
          <button type="button" className={actionClass} disabled={busy} onClick={() => setConfirming(true)}>
            Unpublish
          </button>
        </div>
      ) : null}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unpublish “{envName}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The app stops serving at its address. The environment and its files stay, and it can be published again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <button type="button" className={actionClass} disabled={busy} onClick={() => void unpublish()}>
              Unpublish
            </button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
