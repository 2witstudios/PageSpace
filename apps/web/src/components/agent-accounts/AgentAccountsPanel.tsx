'use client';

import React, { useState } from 'react';
import { toast } from 'sonner';
import { KeyRound, Plus } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { post } from '@/lib/auth/auth-fetch';
import { useAgentAccounts, type AgentAccountScope } from '@/hooks/useAgentAccounts';
import { AddAgentAccountDialog } from './AddAgentAccountDialog';

const hostOf = (origin: string) => origin.replace(/^https:\/\//, '').replace(/:443$/, '');

/**
 * The Accounts settings for an agent page, or for the global assistant in personal settings (G2).
 * Lists accounts by name, site and status — never a key, which the browser never receives — shows which
 * acknowledgment was given when each was added, and revokes.
 */
export function AgentAccountsPanel({ scope }: { readonly scope: AgentAccountScope }) {
  const { configured, accounts, isLoading, error, mutate } = useAgentAccounts(scope);
  const [adding, setAdding] = useState(false);

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
            {scope.kind === 'user' ? 'API keys your global assistant can use.' : 'API keys this agent can use.'} The agent refers to an account by name and never sees its key.
          </CardDescription>
        </div>
        {configured && (
          <Button size="sm" onClick={() => setAdding(true)}>
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
                <Badge variant="outline">{account.acknowledgment === 'personal_login_acknowledged' ? 'Personal login (acknowledged)' : 'Dedicated account'}</Badge>
              </div>
              <div className="text-xs text-muted-foreground truncate">
                {account.allowedOrigins.map(hostOf).join(', ')} · id {account.id}
                {account.lastUsedAt ? ` · last used ${new Date(account.lastUsedAt).toLocaleString()}` : ''}
              </div>
            </div>
            {account.status === 'active' && (
              <Button size="sm" variant="outline" onClick={() => revoke(account.id, account.name)}>
                Revoke
              </Button>
            )}
          </div>
        ))}
      </CardContent>
      <AddAgentAccountDialog scope={scope} open={adding} onOpenChange={setAdding} onCreated={() => void mutate()} />
    </Card>
  );
}
