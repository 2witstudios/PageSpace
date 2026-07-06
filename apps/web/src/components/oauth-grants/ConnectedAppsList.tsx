'use client';

import { useCallback, useEffect, useState } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { post, del } from '@/lib/auth/auth-fetch';
import { useOAuthGrants, type OAuthGrant } from '@/hooks/useOAuthGrants';
import { readStepUpTokenFromHash, stripStepUpTokenFromHash, isNoPasskeyError } from './step-up-hash';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle } from 'lucide-react';
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
import { toast } from 'sonner';

/**
 * Revoking is step-up gated (Phase 8 task cg0aqe6bu21qg2tj7lgswf38): a
 * WebAuthn tap for users with a passkey, or a single-use magic link to their
 * own inbox otherwise. A magic link redirects back to this same settings
 * page rather than the tab that requested it, so which grant to finish
 * revoking has to survive that round trip — sessionStorage carries it, the
 * URL fragment carries the resulting grant, and the mount effect below
 * reconciles the two.
 */
const PENDING_REVOKE_STORAGE_KEY = 'pagespace:pendingOAuthGrantRevokeId';

function buildRevokeActionBinding(grantId: string): Record<string, string> {
  return { op: 'revoke_oauth_grant', grantId };
}

export function ConnectedAppsList() {
  const { grants, isLoading, isError, refetch } = useOAuthGrants();
  const [confirmingGrant, setConfirmingGrant] = useState<OAuthGrant | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [awaitingEmailForId, setAwaitingEmailForId] = useState<string | null>(null);

  const revokeGrant = useCallback(
    async (grantId: string, stepUpToken: string) => {
      setRevokingId(grantId);
      try {
        await del(`/api/account/oauth-grants/${grantId}`, { stepUpToken });
        toast.success('Access revoked');
        refetch();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Failed to revoke access');
      } finally {
        setRevokingId(null);
        setAwaitingEmailForId(null);
        setConfirmingGrant(null);
      }
    },
    [refetch],
  );

  useEffect(() => {
    const tokenFromEmail = readStepUpTokenFromHash(window.location.hash);
    const pendingGrantId = sessionStorage.getItem(PENDING_REVOKE_STORAGE_KEY);
    if (!tokenFromEmail || !pendingGrantId) return;

    sessionStorage.removeItem(PENDING_REVOKE_STORAGE_KEY);
    const cleanedHash = stripStepUpTokenFromHash(window.location.hash);
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${cleanedHash}`);
    revokeGrant(pendingGrantId, tokenFromEmail);
  }, [revokeGrant]);

  async function runWebauthnStepUp(grantId: string): Promise<string> {
    const actionBinding = buildRevokeActionBinding(grantId);
    const { options } = await post<{ options: { challenge: string }; challengeId: string }>(
      '/api/auth/step-up/webauthn/options',
      { actionBinding },
    );
    const webauthnResponse = await startAuthentication({ optionsJSON: options as never });
    const { stepUpToken } = await post<{ stepUpToken: string }>('/api/auth/step-up/webauthn/verify', {
      response: webauthnResponse,
      expectedChallenge: options.challenge,
      actionBinding,
    });
    return stepUpToken;
  }

  async function requestMagicLinkStepUp(grantId: string): Promise<void> {
    const actionBinding = buildRevokeActionBinding(grantId);
    const next = `${window.location.pathname}${window.location.search}`;
    sessionStorage.setItem(PENDING_REVOKE_STORAGE_KEY, grantId);
    await post('/api/auth/step-up/magic-link/request', { actionBinding, next });
  }

  const handleConfirmRevoke = async () => {
    if (!confirmingGrant) return;
    const grantId = confirmingGrant.id;
    setRevokingId(grantId);
    try {
      const stepUpToken = await runWebauthnStepUp(grantId);
      await revokeGrant(grantId, stepUpToken);
    } catch (error) {
      if (isNoPasskeyError(error)) {
        await requestMagicLinkStepUp(grantId);
        setAwaitingEmailForId(grantId);
        setRevokingId(null);
        return;
      }
      toast.error('Something went wrong. Please try again.');
      setRevokingId(null);
    }
  };

  if (isLoading) {
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
        <AlertDescription>Failed to load connected apps. Please try refreshing the page.</AlertDescription>
      </Alert>
    );
  }

  if (!grants || grants.length === 0) {
    return (
      <div className="py-8 text-center text-muted-foreground">
        <p>No connected apps.</p>
      </div>
    );
  }

  return (
    <>
      <div className="divide-y divide-border rounded-lg border border-border bg-card">
        {grants.map((grant) => (
          <div key={grant.id} className="flex items-center justify-between gap-4 p-4">
            <div className="min-w-0">
              <p className="font-medium">{grant.clientName}</p>
              <ul className="mt-1 list-inside list-disc space-y-0.5 text-sm text-muted-foreground">
                {grant.scopeDescriptions.map((description, i) => (
                  <li key={i}>{description}</li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-muted-foreground">
                Connected {new Date(grant.createdAt).toLocaleDateString()}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmingGrant(grant)}
              disabled={revokingId === grant.id}
            >
              {awaitingEmailForId === grant.id ? 'Check email…' : revokingId === grant.id ? 'Revoking…' : 'Revoke'}
            </Button>
          </div>
        ))}
      </div>

      <AlertDialog open={!!confirmingGrant} onOpenChange={(open) => !open && setConfirmingGrant(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke access for {confirmingGrant?.clientName}?</AlertDialogTitle>
            <AlertDialogDescription>
              This immediately ends its access to your account. You&apos;ll need to reconnect it if you want to
              use it again. Confirming requires a fresh passkey tap (or a confirmation email if you have no
              passkey).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revokingId === confirmingGrant?.id}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmRevoke}
              disabled={revokingId === confirmingGrant?.id}
              className="bg-destructive hover:bg-destructive/90"
            >
              Revoke Access
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
