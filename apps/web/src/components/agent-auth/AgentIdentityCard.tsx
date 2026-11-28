'use client';

import { useState, type ReactNode } from 'react';
import { Bot, KeyRound } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuthStore } from '@/stores/useAuthStore';
import { CopyValueButton } from './CopyValueButton';
import { AgentClaimLink } from './AgentClaimLink';
import { RotateAgentSecretDialog } from './RotateAgentSecretDialog';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-1.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="flex min-w-0 items-center gap-2 text-sm">{children}</div>
    </div>
  );
}

/**
 * Settings → Account for an AI agent's own session (Agent Signup Phase 3):
 * who this agent is, who owns it, and the two things only it can do from
 * here — rotate its secret and get a claim link. Renders nothing for a human.
 */
export function AgentIdentityCard() {
  const user = useAuthStore((state) => state.user);
  const [rotateOpen, setRotateOpen] = useState(false);

  if (!user || user.accountType !== 'agent') return null;

  const ownerUserId = user.agent?.ownerUserId ?? null;
  const claimedAt = user.agent?.claimedAt ? new Date(user.agent.claimedAt) : null;

  return (
    <Card className="mb-6" id="agent-identity" data-testid="agent-identity-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="h-5 w-5" aria-hidden="true" />
          Agent identity
        </CardTitle>
        <CardDescription>This is an AI agent account. It signs in with its agent secret.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="divide-y">
          <Row label="Agent ID">
            <code className="truncate font-mono text-xs" data-testid="agent-identity-id">{user.id}</code>
            <CopyValueButton value={user.id} label="Copy agent ID" />
          </Row>
          <Row label="Account type">
            <Badge variant="secondary">AI agent</Badge>
          </Row>
          {user.agent?.source && (
            <Row label="Source">
              <span>{user.agent.source}</span>
            </Row>
          )}
          <Row label="Owner">
            {ownerUserId ? (
              <span data-testid="agent-identity-owner">
                Claimed by <code className="font-mono text-xs">{ownerUserId}</code>
                {claimedAt && !Number.isNaN(claimedAt.getTime()) ? ` on ${claimedAt.toLocaleDateString()}` : ''}
              </span>
            ) : (
              <Badge variant="outline" data-testid="agent-identity-owner">Unclaimed</Badge>
            )}
          </Row>
        </div>

        {!ownerUserId && (
          <div className="space-y-2 rounded-md border p-3">
            <p className="text-sm">
              This agent has no AI credits. A human who claims it pays for its AI usage at their own tier.
            </p>
            <AgentClaimLink />
          </div>
        )}

        <div>
          <Button type="button" variant="outline" onClick={() => setRotateOpen(true)}>
            <KeyRound className="mr-2 h-4 w-4" aria-hidden="true" />
            Rotate secret
          </Button>
        </div>
        <RotateAgentSecretDialog open={rotateOpen} onOpenChange={setRotateOpen} />
      </CardContent>
    </Card>
  );
}
