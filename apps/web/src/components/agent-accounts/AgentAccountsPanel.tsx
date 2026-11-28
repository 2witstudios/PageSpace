'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { KeyRound, Plus } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { patch, post } from '@/lib/auth/auth-fetch';
import { readStepUpTokenFromHash, stripStepUpTokenFromHash } from '@/lib/auth/step-up-ceremony';
import { useAgentAccounts, type AgentAccountScope } from '@/hooks/useAgentAccounts';
import { refusalOf, takePendingAccountChange } from '@/hooks/useAgentAccountSettings';
import { AddAgentAccountDialog } from './AddAgentAccountDialog';
import { AgentAccountPermissionsDialog } from './AgentAccountPermissionsDialog';

const CONNECT_COPY: Readonly<Record<string, string>> = {
  cancelled: 'Google was not connected: the sign-in was cancelled.',
  expired: 'That Google sign-in took too long or was started in another browser. Try again.',
  no_refresh_token: 'Google did not allow ongoing access. Try again and approve every permission asked for.',
  no_service_granted: 'Google was connected without any of the permissions chosen. Try again and leave them ticked.',
  identity_invalid: 'Google did not confirm which account was used. Try again.',
  not_configured: 'Connecting Google is not set up on this PageSpace deployment.',
  forbidden: 'Only a drive owner or admin can add an account to this agent.',
  rate_limited: 'Too many Google sign-ins in a short time. Wait a few minutes and try again.',
};

/** The outcome Google's redirect back carried (`?agentAccount=`), shown once and then removed from the URL. */
function useConnectOutcome(onConnected: () => void) {
  useEffect(() => {
    const url = new URL(window.location.href);
    const outcome = url.searchParams.get('agentAccount');
    if (outcome === null) return;
    url.searchParams.delete('agentAccount');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    if (outcome === 'connected') {
      toast.success('Google account connected. The agent can use it now; open Permissions to choose what it may do without asking.');
      onConnected();
    } else {
      toast.error(CONNECT_COPY[outcome] ?? 'Google could not be connected.');
    }
  }, [onConnected]);
}

/** Resume a change parked while its magic-link step-up was in the person's inbox. */
function useResumePendingAccountChange(onApplied: () => void) {
  useEffect(() => {
    const token = readStepUpTokenFromHash(window.location.hash);
    if (token === null) return;
    const change = takePendingAccountChange(Date.now());
    if (change === null) {
      // The token is left in place: it may belong to another flow on this page.
      toast.error('That confirmation link has no account change waiting (it may have expired). Make the change again.');
      return;
    }
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${stripStepUpTokenFromHash(window.location.hash)}`);
    const send = change.method === 'PATCH' ? patch : post;
    send(change.url, { ...change.body, stepUpToken: token })
      .then(() => {
        toast.success('Confirmed — the account change is applied.');
        onApplied();
      })
      .catch((error: unknown) => toast.error(refusalOf(error) === 'step_up_required' ? 'That confirmation link expired. Make the change again.' : 'The account change could not be applied.'));
  }, [onApplied]);
}

/** An account's site as a person reads it: the scheme's OWN default port is implied (443 for https, 22 for ssh). */
const hostOf = (origin: string) => (origin.startsWith('ssh://') ? `ssh ${origin.slice('ssh://'.length).replace(/:22$/, '')}` : origin.replace(/^https:\/\//, '').replace(/:443$/, ''));

/**
 * The Accounts settings for an agent page, or for the global assistant in personal settings (G2).
 * Lists accounts by name, site and status — never a key, which the browser never receives — shows which
 * acknowledgment was given when each was added, and revokes.
 */
export function AgentAccountsPanel({ scope }: { readonly scope: AgentAccountScope }) {
  const { configured, accounts, isLoading, error, mutate } = useAgentAccounts(scope);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const refresh = useCallback(() => void mutate(), [mutate]);
  useResumePendingAccountChange(refresh);
  useConnectOutcome(refresh);

  const revoke = async (accountId: string, name: string) => {
    if (!window.confirm(`Stop PageSpace from using "${name}"? The key stays valid at the site until you revoke it there too.`)) return;
    try {
      await post(`/api/agent-accounts/${accountId}/revoke`, {});
      toast.success('Account revoked. Revoke the key at the site as well to fully disable it.');
      await mutate();
    } catch {
      toast.error('The account could not be revoked.');
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" /> Accounts
          </CardTitle>
          <CardDescription>
            {scope.kind === 'user' ? 'API keys your global assistant — and any agent you attach them to — can use.' : 'API keys this agent can use.'} The agent refers to an account by name and never sees its key. Open Permissions to choose sites, approvals and scheduled use.
          </CardDescription>
        </div>
        {configured && (
          <Button type="button" size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4 mr-1" /> Add account
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        {!configured && <p className="text-sm text-muted-foreground">Agent accounts are not set up on this PageSpace deployment.</p>}
        {isLoading && <Skeleton className="h-12 w-full" />}
        {error && <p className="text-sm text-destructive">Accounts could not be loaded.</p>}
        {configured && !isLoading && accounts.length === 0 && <p className="text-sm text-muted-foreground">No accounts yet.</p>}
        {accounts.map((account) => (
          <div key={account.id} className="flex items-center justify-between gap-3 rounded-md border p-3">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium truncate">{account.name}</span>
                <Badge variant={account.status === 'active' ? 'secondary' : 'destructive'}>{account.status}</Badge>
                {!account.ready && account.status === 'active' && <Badge variant="outline">Not ready — add it again</Badge>}
                {account.providerSlug === 'google' && <Badge variant="outline">Google</Badge>}
                {account.kind === 'ssh_key' && <Badge variant="outline">SSH</Badge>}
                {account.status === 'needs_reauth' && <Badge variant="destructive">Google sign-in expired — connect it again</Badge>}
                <Badge variant="outline">{account.acknowledgment === 'personal_login_acknowledged' ? 'Personal login (acknowledged)' : 'Dedicated account'}</Badge>
                {scope.kind === 'agent_page' && account.ownerKind === 'user' && <Badge variant="outline">Yours, attached</Badge>}
              </div>
              <div className="text-xs text-muted-foreground truncate">
                {account.allowedOrigins.map(hostOf).join(', ')} · id {account.id}
                {account.lastUsedAt ? ` · last used ${new Date(account.lastUsedAt).toLocaleString()}` : ''}
              </div>
            </div>
            {account.status === 'active' && (
              <div className="flex shrink-0 gap-2">
                {account.publicKey && (
                  <Button type="button" size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(account.publicKey ?? '').then(() => toast.success('Public key copied. Add it to ~/.ssh/authorized_keys on the server.'), () => toast.error(`Could not copy. The public key is: ${account.publicKey ?? ''}`))}>
                    Copy public key
                  </Button>
                )}
                {account.ready && (
                  <Button type="button" size="sm" variant="outline" onClick={() => setEditing(account.id)}>
                    Permissions
                  </Button>
                )}
                {(account.ownerKind === 'agent_page' || scope.kind === 'user') && (
                  <Button type="button" size="sm" variant="outline" onClick={() => revoke(account.id, account.name)}>
                    Revoke
                  </Button>
                )}
              </div>
            )}
          </div>
        ))}
      </CardContent>
      <AddAgentAccountDialog scope={scope} open={adding} onOpenChange={setAdding} onCreated={() => void mutate()} />
      <AgentAccountPermissionsDialog
        accountId={editing}
        ownerAgentPageId={scope.kind === 'agent_page' ? scope.pageId : null}
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        onChanged={() => void mutate()}
      />
    </Card>
  );
}
