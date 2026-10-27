'use client';

/**
 * ONE environment's settings — the detail half of the `RolesManager` shape
 * (GA wave 3, leaf 4). For a LOCAL environment this is the place the highest-
 * consequence permission in the product — execute on my laptop — can be seen
 * and changed in the product:
 *
 * - **status** (connected / connecting / disconnected / paused, enrolled or
 *   awaiting), and who owns the machine;
 * - **`serverPolicy` toggles** — Read files / Write files / Run commands —
 *   the OWNER's alone ([D-6]): a drive admin who did not enrol the machine
 *   sees them read-only with a line naming the owner. `bindPolicy` is not
 *   shown: it is `'owner'` and no longer a choice;
 * - **effective capability**, rendered by `intersectCapabilities` — its first
 *   production caller — over what the machine ADVERTISED, what PageSpace
 *   ALLOWS, and (unknown to the server, so taken as open) what the machine's
 *   own policy file allows; the page says so rather than pretend;
 * - **activity** — the live panel, owner only;
 * - **Stop / Resume** (owner only) and **Revoke** (owner OR drive admin —
 *   a reduction is not driving).
 *
 * Registered with `useEditingStore` while mounted: a toggle in flight must
 * not be torn down by a background revalidation or an auth refresh.
 */

import { useCallback, useMemo, useState } from 'react';
import useSWR from 'swr';
import { ChevronLeft, Laptop, Loader2, Pause, Play, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { del, fetchWithAuth, patch } from '@/lib/auth/auth-fetch';
import { useEditingSession } from '@/stores/useEditingSession';
import { EnvActivityPanel } from '@/components/agents/EnvActivityPanel';
import { intersectCapabilities } from '@pagespace/lib/env-bridge/intersect-capabilities';
import { GRANT_OPS, type GrantOp } from '@pagespace/lib/env-bridge/grant';
import { SERVER_POLICY_OPS, type DriveEnvDTO } from '@pagespace/lib/drive-envs/env-contract';

/** The toggles this page renders — and therefore the ONLY words the `no_server_ops` refusal may name (its test reads this list). */
export const SERVER_POLICY_TOGGLES: ReadonlyArray<{ op: (typeof SERVER_POLICY_OPS)[number]; label: string; hint: string }> = [
  { op: 'fs_read', label: 'Read files', hint: 'PageSpace may ask the machine to read files inside its allowed roots.' },
  { op: 'fs_write', label: 'Write files', hint: 'PageSpace may ask the machine to write files inside its allowed roots.' },
  { op: 'exec', label: 'Run commands', hint: 'PageSpace may ask the machine to run commands. Every command still needs your click in the chat; it runs as you.' },
];

const OP_LABEL: Record<GrantOp, string> = { exec: 'Run commands', fs_read: 'Read files', fs_write: 'Write files', pty_open: 'Terminal' };

type LocalEnv = Extract<DriveEnvDTO, { substrate: 'local' }>;

interface MemberLike {
  userId: string;
  user?: { name?: string | null; email?: string | null } | null;
  name?: string | null;
  email?: string | null;
}

async function membersFetcher(url: string): Promise<{ members: MemberLike[] }> {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error(`Failed to load members (${response.status})`);
  return response.json();
}

/** A name for the owner when the drive's member list has one; the id otherwise (never nothing). */
export function ownerDisplayName(ownerId: string | null, members: MemberLike[] | undefined): string {
  if (ownerId === null) return 'an erased account';
  const member = members?.find((m) => m.userId === ownerId);
  return member?.user?.name ?? member?.name ?? member?.user?.email ?? member?.email ?? ownerId;
}

export interface EnvironmentEditorProps {
  driveId: string;
  env: LocalEnv;
  /** The signed-in user's id — compared to `env.ownerId`, never to a drive role. */
  viewerId: string | null;
  /** Drive owner or admin: may Revoke (delete), never drive. */
  canAdminister: boolean;
  onChanged: () => void;
  onBack: () => void;
  onRevoked: () => void;
}

function statusOf(env: LocalEnv): { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' } {
  if (!env.enrolled) return { label: 'Awaiting enrollment', variant: 'outline' };
  if (env.paused) return { label: 'Stopped', variant: 'destructive' };
  if (env.status === 'connected') return { label: 'Connected', variant: 'default' };
  if (env.status === 'connecting') return { label: 'Connecting', variant: 'outline' };
  return { label: 'Not connected', variant: 'secondary' };
}

export function EnvironmentEditor({ driveId, env, viewerId, canAdminister, onChanged, onBack, onRevoked }: EnvironmentEditorProps) {
  const isOwner = viewerId !== null && env.ownerId === viewerId;
  const [saving, setSaving] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const { data: membersData } = useSWR(`/api/drives/${encodeURIComponent(driveId)}/members`, membersFetcher, { revalidateOnFocus: false });
  const ownerName = ownerDisplayName(env.ownerId, membersData?.members);
  const envPath = `/api/drives/${encodeURIComponent(driveId)}/envs/${encodeURIComponent(env.id)}`;

  useEditingSession(`drive-env-editor-${env.id}`, true, 'form', { componentName: 'EnvironmentEditor' });

  const effective = useMemo(
    () =>
      intersectCapabilities(
        // Before the first hello the machine has advertised nothing: every op reads as not yet possible.
        env.capabilities ?? { shell: false, pty: false, fs: false, checkpoint: false },
        { ops: env.serverPolicy.ops, checkpoint: env.serverPolicy.checkpoint },
        // The machine's own policy file is not known to the server; it can only narrow. Taken as open here and SAID so below.
        { ops: [...GRANT_OPS], checkpoint: false },
      ),
    [env.capabilities, env.serverPolicy],
  );

  const setOp = useCallback(
    async (op: (typeof SERVER_POLICY_OPS)[number], on: boolean) => {
      const ops = on ? [...new Set([...env.serverPolicy.ops, op])] : env.serverPolicy.ops.filter((existing) => existing !== op);
      setSaving(op);
      try {
        await patch(envPath, { serverPolicy: { ops: ops.filter((o): o is (typeof SERVER_POLICY_OPS)[number] => (SERVER_POLICY_OPS as readonly string[]).includes(o)), checkpoint: false } });
        toast.success(`${OP_LABEL[op]} ${on ? 'allowed' : 'no longer allowed'} on ${env.label}`);
        onChanged();
      } catch (error) {
        toast.error('Could not change what PageSpace may ask this machine to do', { description: error instanceof Error ? error.message : 'Please try again.' });
      } finally {
        setSaving(null);
      }
    },
    [env.serverPolicy.ops, env.label, envPath, onChanged],
  );

  const setPaused = useCallback(
    async (paused: boolean) => {
      setSaving('paused');
      try {
        await patch(envPath, { paused });
        toast.success(paused ? `Stopped ${env.label}: PageSpace will sign nothing for it until you resume` : `Resumed ${env.label}`);
        onChanged();
      } catch (error) {
        toast.error(paused ? 'Could not stop the environment' : 'Could not resume the environment', { description: error instanceof Error ? error.message : 'Please try again.' });
      } finally {
        setSaving(null);
      }
    },
    [env.label, envPath, onChanged],
  );

  const revoke = useCallback(async () => {
    setSaving('revoke');
    try {
      await del(`${envPath}?force=true`);
      toast.success(`Revoked ${env.label}: the machine's key is deleted and the environment is gone`);
      onRevoked();
    } catch (error) {
      toast.error('Could not revoke the environment', { description: error instanceof Error ? error.message : 'Please try again.' });
    } finally {
      setSaving(null);
      setConfirmRevoke(false);
    }
  }, [env.label, envPath, onRevoked]);

  const status = statusOf(env);

  return (
    <div className="space-y-6" data-testid={`env-editor-${env.id}`}>
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ChevronLeft className="h-4 w-4 mr-1" />
        Back to environments
      </Button>

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <Laptop className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
              <div>
                <CardTitle className="text-lg">{env.name}</CardTitle>
                <CardDescription>
                  On {env.label} · owned by <span data-testid="env-owner-name">{ownerName}</span>
                </CardDescription>
              </div>
            </div>
            <Badge variant={status.variant} data-testid="env-status">
              {status.label}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {!isOwner && (
            <p className="rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground" data-testid="env-read-only-notice">
              Only this machine&apos;s owner, {ownerName}, can change what it may run or stop it. Drive admins can delete or revoke it, but not drive it.
            </p>
          )}

          <section aria-labelledby={`policy-${env.id}`} className="space-y-3">
            <div>
              <h3 id={`policy-${env.id}`} className="text-sm font-semibold">
                What PageSpace may ask this machine to do
              </h3>
              <p className="text-xs text-muted-foreground">Enforced when a grant is signed. The machine&apos;s own policy file applies on top.</p>
            </div>
            <div className="space-y-3">
              {SERVER_POLICY_TOGGLES.map(({ op, label, hint }) => {
                const on = env.serverPolicy.ops.includes(op);
                const id = `toggle-${env.id}-${op}`;
                return (
                  <div key={op} className="flex items-start justify-between gap-4">
                    <div>
                      <Label htmlFor={id}>{label}</Label>
                      <p className="text-xs text-muted-foreground">{hint}</p>
                    </div>
                    <Switch id={id} checked={on} disabled={!isOwner || saving !== null} aria-label={label} onCheckedChange={(next) => void setOp(op, next)} />
                  </div>
                );
              })}
            </div>
          </section>

          <section aria-labelledby={`effective-${env.id}`} className="space-y-2">
            <h3 id={`effective-${env.id}`} className="text-sm font-semibold">
              What can actually run
            </h3>
            <ul className="space-y-1 text-sm" data-testid="env-effective">
              {(['fs_read', 'fs_write', 'exec', 'pty_open'] as const).map((op) => (
                <li key={op} className="flex items-center justify-between" data-op={op} data-allowed={effective[op] ? 'true' : 'false'}>
                  <span>{OP_LABEL[op]}</span>
                  <span className={effective[op] ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}>{effective[op] ? 'Possible' : 'Not possible'}</span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              {env.capabilities === null
                ? 'The machine has not connected yet, so nothing can run until it does.'
                : 'Machine advertised ∩ PageSpace allows. The machine’s own policy file (mode, roots, principals) may narrow this further; the server cannot see it.'}
            </p>
          </section>

          <section className="flex flex-wrap gap-2" aria-label="Environment actions">
            {isOwner && env.enrolled && (
              <Button variant={env.paused ? 'default' : 'outline'} size="sm" disabled={saving !== null} onClick={() => void setPaused(!env.paused)} data-testid="env-stop-resume">
                {saving === 'paused' ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : env.paused ? <Play className="h-4 w-4 mr-1" /> : <Pause className="h-4 w-4 mr-1" />}
                {env.paused ? 'Resume' : 'Stop'}
              </Button>
            )}
            {(isOwner || canAdminister) && (
              <Button variant="destructive" size="sm" disabled={saving !== null} onClick={() => setConfirmRevoke(true)} data-testid="env-revoke">
                <ShieldOff className="h-4 w-4 mr-1" />
                Revoke
              </Button>
            )}
          </section>
        </CardContent>
      </Card>

      {isOwner && env.enrolled && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Activity</CardTitle>
            <CardDescription>What is running on {env.label} right now, and what ran. Only you can see this.</CardDescription>
          </CardHeader>
          <CardContent>
            <EnvActivityPanel driveId={driveId} envId={env.id} enabled tailSize={20} />
          </CardContent>
        </Card>
      )}

      <AlertDialog open={confirmRevoke} onOpenChange={setConfirmRevoke}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {env.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              The machine&apos;s key is deleted, its connection is closed, every session inside this environment ends, and the environment is removed from this drive. To use the machine again it must be enrolled from scratch. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving === 'revoke'}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void revoke()} disabled={saving === 'revoke'} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
