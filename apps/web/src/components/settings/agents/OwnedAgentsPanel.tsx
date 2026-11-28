'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import useSWR from 'swr';
import { toast } from 'sonner';
import { Bot, Copy } from 'lucide-react';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export interface OwnedAgentView {
  id: string;
  name: string;
  source: string | null;
  createdAt: string;
  claimedAt: string | null;
  lastActiveAt: string | null;
  revokedAt: string | null;
}

const AGENTS_URL = '/api/account/agents';

const fetcher = async (url: string): Promise<{ agents: OwnedAgentView[] }> => {
  const res = await fetchWithAuth(url);
  if (!res.ok) throw new Error(`Failed to load agents (${res.status})`);
  return res.json();
};

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetchWithAuth(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json() as Promise<T>;
}

function formatDate(iso: string | null): string {
  if (!iso) return 'never';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** A one-time secret, shown with a copy button; it is never shown again. */
function OneTimeValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{label}</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 break-all rounded bg-muted px-2 py-1.5 font-mono text-xs">{value}</code>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Copy"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => toast.success('Copied'));
          }}
        >
          <Copy className="h-4 w-4" />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Copy it now — it is not shown again.</p>
    </div>
  );
}

type Pending =
  | { kind: 'revoke'; agent: OwnedAgentView }
  | { kind: 'unlink'; agent: OwnedAgentView }
  | { kind: 'rotate'; agent: OwnedAgentView; revokeExistingTokens: boolean };

type Revealed = { title: string; label: string; value: string; note: string };

/**
 * Settings → Agents (ADR 0008, Agent Signup Phase 4): the AI agents this human
 * has claimed and pays for, with name, source and last activity, and per agent
 * Revoke (its secret, sessions, tokens and keys all die), Rotate secret (the
 * new secret is shown once, for the human to hand to the agent) and Unlink
 * (release it; nothing secret is shown — the agent asks to be claimed again
 * itself, with its own credential). "Claim an agent" takes the
 * code an agent gave you to the /claim consent screen.
 */
export function OwnedAgentsPanel() {
  const router = useRouter();
  const { data, error, isLoading, mutate } = useSWR(AGENTS_URL, fetcher, { revalidateOnFocus: false });
  const [pending, setPending] = useState<Pending | null>(null);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [busy, setBusy] = useState(false);
  const [claimCode, setClaimCode] = useState('');

  const agents = data?.agents ?? [];

  async function run(action: Pending) {
    setBusy(true);
    try {
      if (action.kind === 'revoke') {
        await postJson(`/api/account/agents/${encodeURIComponent(action.agent.id)}/revoke`);
        toast.success(`${action.agent.name} was revoked`);
      } else if (action.kind === 'unlink') {
        // Nothing secret comes back: the agent asks to be claimed again itself, with its own credential.
        await postJson(`/api/account/agents/${encodeURIComponent(action.agent.id)}/unlink`);
        toast.success(`${action.agent.name} is no longer yours. You no longer pay for its AI usage.`);
      } else {
        const result = await postJson<{ identity_assertion: string }>('/api/agent/secret/rotate', {
          agentId: action.agent.id,
          revokeExistingTokens: action.revokeExistingTokens,
        });
        setRevealed({
          title: `New secret for ${action.agent.name}`,
          label: 'Agent secret',
          value: result.identity_assertion,
          note: action.revokeExistingTokens
            ? 'The old secret no longer works, and every token and key the agent held has been revoked. Give the agent this secret so it can sign in again.'
            : 'The old secret no longer works. Give the agent this secret; its current tokens keep working.',
        });
      }
      setPending(null);
      await mutate();
    } catch {
      toast.error('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  const normalizedClaimCode = claimCode.trim().toUpperCase();

  return (
    <div className="space-y-6">
      <section className="space-y-3 rounded-lg border p-4">
        <h2 className="text-base font-medium">Claim an agent</h2>
        <p className="text-sm text-muted-foreground">
          An AI agent with its own PageSpace account can ask you to claim it. Enter the code it gave you; you will see who it is before anything changes. Once claimed, you pay for its AI usage.
        </p>
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            if (normalizedClaimCode.length === 0) return;
            router.push(`/claim?user_code=${encodeURIComponent(normalizedClaimCode)}`);
          }}
        >
          <div className="flex-1 space-y-1">
            <Label htmlFor="owned-agents-claim-code">Agent code</Label>
            <Input
              id="owned-agents-claim-code"
              value={claimCode}
              onChange={(event) => setClaimCode(event.target.value)}
              placeholder="XXXX-XXXX"
              autoComplete="off"
              className="font-mono uppercase"
            />
          </div>
          <Button type="submit" disabled={normalizedClaimCode.length === 0}>Claim an agent</Button>
        </form>
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-medium">Your agents</h2>
        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {error && <p className="text-sm text-destructive">Could not load your agents.</p>}
        {!isLoading && !error && agents.length === 0 && (
          <p className="text-sm text-muted-foreground">You have not claimed any agents yet.</p>
        )}
        <ul className="divide-y rounded-lg border">
          {agents.map((agent) => (
            <li key={agent.id} data-testid={`owned-agent-${agent.id}`} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-start gap-3">
                <Bot className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{agent.name}</span>
                    {agent.revokedAt && <Badge variant="secondary">Revoked</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {agent.source ? `${agent.source} · ` : ''}Last active {formatDate(agent.lastActiveAt)} · Claimed {formatDate(agent.claimedAt)}
                  </p>
                </div>
              </div>
              {!agent.revokedAt && (
                <div className="flex shrink-0 gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => setPending({ kind: 'rotate', agent, revokeExistingTokens: false })}>
                    Rotate secret
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => setPending({ kind: 'unlink', agent })}>
                    Unlink
                  </Button>
                  <Button type="button" variant="destructive" size="sm" onClick={() => setPending({ kind: 'revoke', agent })}>
                    Revoke
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      <AlertDialog open={pending?.kind === 'revoke' || pending?.kind === 'unlink'} onOpenChange={(open) => { if (!open) setPending(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.kind === 'revoke' ? `Revoke ${pending.agent.name}?` : pending ? `Unlink ${pending.agent.name}?` : ''}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.kind === 'revoke'
                ? 'Its secret stops working and every session, token and key it holds is revoked immediately. This cannot be undone.'
                : 'It keeps its account, drives and keys, but you stop paying for its AI usage and it can no longer message or invite people. Only the agent itself can ask to be claimed again.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                if (pending) void run(pending);
              }}
            >
              {pending?.kind === 'revoke' ? 'Revoke agent' : 'Unlink agent'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={pending?.kind === 'rotate'} onOpenChange={(open) => { if (!open) setPending(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pending?.kind === 'rotate' ? `Rotate the secret for ${pending.agent.name}` : ''}</DialogTitle>
            <DialogDescription>
              The current secret stops working immediately. You will see the new one once, to give to the agent.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <Checkbox
              id="owned-agents-revoke-tokens"
              checked={pending?.kind === 'rotate' && pending.revokeExistingTokens}
              onCheckedChange={(checked) => {
                if (pending?.kind === 'rotate') setPending({ ...pending, revokeExistingTokens: checked === true });
              }}
            />
            <Label htmlFor="owned-agents-revoke-tokens" className="text-sm font-normal">
              Also sign it out everywhere (revoke its live tokens and keys)
            </Label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setPending(null)}>Cancel</Button>
            <Button type="button" disabled={busy} onClick={() => { if (pending) void run(pending); }}>Rotate</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={revealed !== null} onOpenChange={(open) => { if (!open) setRevealed(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{revealed?.title}</DialogTitle>
            <DialogDescription>{revealed?.note}</DialogDescription>
          </DialogHeader>
          {revealed && <OneTimeValue label={revealed.label} value={revealed.value} />}
          <DialogFooter>
            <Button type="button" onClick={() => setRevealed(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
