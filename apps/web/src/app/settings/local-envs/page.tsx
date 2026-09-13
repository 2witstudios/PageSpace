'use client';

/**
 * Settings → Local environments (GA wave 3, leaf 5). Modelled on
 * `local-mcp/`: the account-level page for the machines a person has
 * enrolled — across every drive — and what those machines will run without
 * asking. This is the user-level control [D-5] asked for, subsumed here:
 * the owner may not be looking at any drive and still needs to see every
 * machine that is theirs, what each is running right now, and revoke any
 * approval in force.
 *
 * Everything on this page is OWNER-ONLY by construction: both reads select
 * by `drive_env_local.ownerId = <caller>` on the server. Changing what a
 * machine may do (its policy, Stop, Revoke) lives on the drive settings page
 * each row links to.
 */

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, AlertTriangle, Laptop, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useEnvApprovals, useOwnerMachines, type OwnerMachine } from '@/hooks/drive-envs/useEnvApprovals';
import { EnvActivityPanel } from '@/components/agents/EnvActivityPanel';
import { EnvApprovalsList } from '@/components/settings/EnvApprovalsList';
import { GlobalAssistantVisibilityToggle } from '@/components/settings/GlobalAssistantVisibilityToggle';

function statusOf(machine: OwnerMachine): { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' } {
  const env = machine.env;
  if (env.substrate !== 'local') return { label: env.status, variant: 'secondary' };
  if (!env.enrolled) return { label: 'Awaiting enrollment', variant: 'outline' };
  if (env.paused) return { label: 'Stopped', variant: 'destructive' };
  if (env.status === 'connected') return { label: 'Connected', variant: 'default' };
  if (env.status === 'connecting') return { label: 'Connecting', variant: 'outline' };
  return { label: 'Not connected', variant: 'secondary' };
}

export default function LocalEnvironmentsSettingsPage() {
  const router = useRouter();
  const machines = useOwnerMachines();
  const approvals = useEnvApprovals();

  return (
    <div className="container mx-auto py-10 space-y-8 px-10">
      <div>
        <Button variant="ghost" size="sm" onClick={() => router.push('/settings')} className="mb-4">
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Settings
        </Button>
        <h1 className="text-3xl font-bold mb-2">Local environments</h1>
        <p className="text-muted-foreground">Your own computers, enrolled as environments. What each is running right now, and what it will run without asking you.</p>
      </div>

      <Alert>
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription>
          <strong>These run as you.</strong> A command PageSpace runs on one of these machines runs with your account&apos;s own privileges. Only you can drive a machine you enrolled; to change what it may do, stop it, or revoke it, open it in its drive&apos;s settings.
        </AlertDescription>
      </Alert>

      <section className="space-y-4" aria-labelledby="machines-heading">
        <h2 id="machines-heading" className="text-xl font-semibold">
          Your machines
        </h2>
        {machines.isLoading && machines.machines.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin" />
          </div>
        ) : machines.isError ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>Failed to load your machines. Please try refreshing the page.</AlertDescription>
          </Alert>
        ) : machines.machines.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center">
              <Laptop className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-semibold mb-2">No machines enrolled</h3>
              <p className="text-muted-foreground">Enroll one from a drive&apos;s New session flow: choose &quot;This computer&quot;.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {machines.machines.map((machine) => {
              const status = statusOf(machine);
              const env = machine.env;
              if (env.substrate !== 'local') return null;
              return (
                <Card key={env.id} data-testid={`machine-${env.id}`}>
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-center gap-3">
                        <Laptop className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
                        <div>
                          <CardTitle className="text-lg">{env.label}</CardTitle>
                          <CardDescription>
                            Environment <span className="font-medium">{env.name}</span> ·{' '}
                            <Link className="underline" href={`/dashboard/${encodeURIComponent(machine.driveId)}/settings/environments?env=${encodeURIComponent(env.id)}`}>
                              open in drive settings
                            </Link>
                          </CardDescription>
                        </div>
                      </div>
                      <Badge variant={status.variant}>{status.label}</Badge>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="mb-3 text-xs text-muted-foreground">
                      PageSpace may: {env.serverPolicy.ops.length === 0 ? 'nothing yet' : env.serverPolicy.ops.map((op) => ({ exec: 'run commands', fs_read: 'read files', fs_write: 'write files', pty_open: 'open a terminal' })[op]).join(', ')}
                    </p>
                    {/* Every machine listed here is one the caller enrolled — the
                        read selects by owner — so the toggle is always theirs. */}
                    <div className="mb-3">
                      <GlobalAssistantVisibilityToggle
                        driveId={machine.driveId}
                        envId={env.id}
                        label={env.label}
                        visible={env.visibleToGlobalAssistant}
                        isOwner
                        onChanged={machines.refetch}
                      />
                    </div>
                    {env.enrolled && <EnvActivityPanel driveId={machine.driveId} envId={env.id} enabled tailSize={5} scope="account" />}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <section className="space-y-4" aria-labelledby="approvals-heading">
        <div>
          <h2 id="approvals-heading" className="text-xl font-semibold">
            Runs without asking
          </h2>
          <p className="text-sm text-muted-foreground">Approvals you gave in the chat. Revoking one makes the machine ask again. Approvals given at a machine&apos;s own terminal prompt live only on that machine and are not listed here.</p>
        </div>
        <EnvApprovalsList approvals={approvals.approvals} isLoading={approvals.isLoading} isError={approvals.isError} refetch={approvals.refetch} />
      </section>
    </div>
  );
}
