'use client';

/**
 * The revocable-approvals list (GA wave 3, leaf 5) — the `ConnectedAppsList`
 * shape (a bordered list, one row per grant, a Revoke button with a confirm
 * dialog, an honest toast) over a local environment's durable approvals: what
 * the owner's machines will run WITHOUT asking, as their chat clicks recorded
 * it. Its own component rather than `ConnectedAppsList` itself because that
 * one is bound to the OAuth grants hook and the step-up ceremony an OAuth
 * revoke needs; an approval revoke's ceremony is the machine's signed ack.
 *
 * Revoke rides wave 2's `DELETE …/envs/[envId]/approvals/[approvalId]` from
 * drive settings, and the owner-scoped `DELETE /api/env-bridge/approvals/[id]`
 * from account settings, and
 * reports what the MACHINE said: acknowledged (gone), 202 unacknowledged
 * (sent, not proven — it will be replayed when the machine reconnects), 409
 * no live socket (the same replay). Never "revoked" without the signature.
 */

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import { ApiRequestError, del } from '@/lib/auth/auth-fetch';
import type { DriveEnvApprovalDTO } from '@pagespace/lib/drive-envs/env-contract';

export interface EnvApprovalsListProps {
  approvals: DriveEnvApprovalDTO[];
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
  /** The drive scope when the list is env-scoped (drive settings); the account list carries it per row. */
  driveId?: string;
}

const SCOPE_LABEL: Record<DriveEnvApprovalDTO['scope'], string> = { session: 'until that daemon restarts', '30d': 'for 30 days', until_revoked: 'until revoked' };

/** What a revoke answer means, in the owner's words. Exported for its own test. */
export function describeRevokeAnswer(status: number, body: { reason?: unknown; removed?: unknown } | null): { title: string; description: string; gone: boolean } {
  if (status === 200) return { title: 'Approval revoked', description: `The machine confirmed it deleted ${typeof body?.removed === 'number' ? body.removed : 'the'} approval row${body?.removed === 1 ? '' : 's'}.`, gone: true };
  if (status === 202) return { title: 'Revoke sent, not yet confirmed', description: 'The machine did not acknowledge in time. It will be asked again the next time it connects, before it runs anything.', gone: false };
  if (status === 409 && body?.reason !== 'not_local' && body?.reason !== 'revoked') return { title: 'Machine not connected', description: 'The revoke is recorded and will be delivered the next time the machine connects, before it runs anything.', gone: false };
  return { title: 'Could not revoke the approval', description: 'Please try again.', gone: false };
}

export function EnvApprovalsList({ approvals, isLoading, isError, refetch, driveId }: EnvApprovalsListProps) {
  const [confirming, setConfirming] = useState<DriveEnvApprovalDTO | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const revoke = useCallback(
    async (approval: DriveEnvApprovalDTO) => {
      // Drive settings (a driveId prop) revokes through the drive route; the ACCOUNT list revokes through the
      // owner-scoped account route, so an owner who has left the drive can still act (Codex P1 #5, review round 1).
      const url = driveId
        ? `/api/drives/${encodeURIComponent(driveId)}/envs/${encodeURIComponent(approval.envId)}/approvals/${encodeURIComponent(approval.id)}`
        : `/api/env-bridge/approvals/${encodeURIComponent(approval.id)}`;
      setRevokingId(approval.id);
      try {
        const body = await del<{ removed?: number }>(url);
        const answer = describeRevokeAnswer(200, body ?? null);
        toast.success(answer.title, { description: answer.description });
      } catch (error) {
        // 202 (unacknowledged) and 409 (no live socket) are honest answers, not failures: the decision is recorded and replayed on reconnect.
        const status = error instanceof ApiRequestError ? error.status : 0;
        const body = error instanceof ApiRequestError ? (error.body as { reason?: unknown } | null) : null;
        const answer = describeRevokeAnswer(status, body);
        if (status === 202 || (status === 409 && !answer.title.startsWith('Could not'))) toast.message(answer.title, { description: answer.description });
        else toast.error(answer.title, { description: error instanceof Error ? error.message : answer.description });
      } finally {
        setRevokingId(null);
        setConfirming(null);
        refetch();
      }
    },
    [driveId, refetch],
  );

  if (isLoading && approvals.length === 0) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (isError) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>Failed to load approvals. Please try refreshing the page.</AlertDescription>
      </Alert>
    );
  }

  if (approvals.length === 0) {
    return (
      <div className="py-8 text-center text-muted-foreground" data-testid="env-approvals-empty">
        <p>No approvals in force. Every command still needs your click in the chat.</p>
      </div>
    );
  }

  return (
    <>
      <div className="divide-y divide-border rounded-lg border border-border bg-card" data-testid="env-approvals-list">
        {approvals.map((approval) => (
          <div key={approval.id} data-testid={`env-approval-${approval.id}`} className="flex items-center justify-between gap-4 p-4">
            <div className="min-w-0">
              <p className="font-mono text-sm truncate" title={approval.summary}>
                {approval.summary}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Runs without asking {SCOPE_LABEL[approval.scope]}
                {approval.expiresAt !== null && ` · until ${new Date(approval.expiresAt).toLocaleDateString()}`}
                {approval.envLabel !== null && (
                  <>
                    {' · on '}
                    {approval.driveId !== null ? (
                      <Link className="underline" href={`/dashboard/${encodeURIComponent(approval.driveId)}/settings/environments?env=${encodeURIComponent(approval.envId)}`}>
                        {approval.envLabel}
                      </Link>
                    ) : (
                      approval.envLabel
                    )}
                  </>
                )}
                {approval.revokePending && ' · revoke pending: the machine has not confirmed yet'}
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setConfirming(approval)} disabled={revokingId === approval.id}>
              {revokingId === approval.id ? 'Revoking…' : 'Revoke'}
            </Button>
          </div>
        ))}
      </div>

      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this approval?</AlertDialogTitle>
            <AlertDialogDescription>
              The machine will ask for your click again before it runs this. If the machine is not connected right now, the revoke is delivered the next time it connects, before it runs anything.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revokingId !== null}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirming && void revoke(confirming)} disabled={revokingId !== null} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
