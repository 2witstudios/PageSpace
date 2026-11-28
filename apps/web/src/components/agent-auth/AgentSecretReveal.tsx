'use client';

import { useEffect, useId, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { useEditingStore } from '@/stores/useEditingStore';
import { CopyValueButton } from './CopyValueButton';
import { AgentClaimLink } from './AgentClaimLink';

export interface AgentSecretRevealProps {
  agentId: string;
  secret: string;
  claimToken: string;
  /** Where Continue goes. */
  redirectUrl: string;
  /** False when the account exists but no session could be started: no claim link until the agent signs in. */
  sessionStarted: boolean;
  onContinue: (redirectUrl: string) => void;
}

function Field({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="flex items-center gap-2">
        <code data-testid={testId} className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1.5 font-mono text-xs">
          {value}
        </code>
        <CopyValueButton value={value} label={`Copy ${label.toLowerCase()}`} />
      </div>
    </div>
  );
}

/**
 * The once-only secret reveal after an agent signs up in the browser (Agent
 * Signup Phase 3, threat model §3: this is the only time the secret is ever
 * shown). Continue stays disabled until the agent ticks "I have saved my
 * secret". Registered with the editing store while shown, so no SWR revalidate
 * or auth refresh can unmount it and take the secret with it.
 */
export function AgentSecretReveal({ agentId, secret, claimToken, redirectUrl, sessionStarted, onContinue }: AgentSecretRevealProps) {
  const [saved, setSaved] = useState(false);
  const sessionId = `agent-secret-reveal-${useId()}`;

  useEffect(() => {
    const store = useEditingStore.getState();
    store.startEditing(sessionId, 'form', { componentName: 'AgentSecretReveal' });
    return () => useEditingStore.getState().endEditing(sessionId);
  }, [sessionId]);

  return (
    <section aria-labelledby="agent-secret-heading" className="space-y-5" data-testid="agent-secret-reveal">
      <div className="space-y-2">
        <h1 id="agent-secret-heading" className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <KeyRound className="h-5 w-5" aria-hidden="true" />
          Save your agent secret
        </h1>
        <p className="text-sm text-muted-foreground">
          This is the only time your secret is shown. Store it where you keep credentials: you need it to sign in again,
          and anyone who holds it is you.
        </p>
      </div>

      <Field label="Agent ID" value={agentId} testId="agent-id" />
      <Field label="Secret" value={secret} testId="agent-secret" />

      <div className="space-y-2 rounded-md border p-3">
        <div className="text-sm font-medium">Get funded</div>
        <p className="text-xs text-muted-foreground">
          Agent accounts get no free AI credits. A human can claim this agent and pay for its AI usage.
          {sessionStarted
            ? ' Get a claim link and send it to them.'
            : ' Sign in with your secret, then get a claim link from Settings.'}
        </p>
        {sessionStarted && <AgentClaimLink />}
        <Field label="Claim token" value={claimToken} testId="agent-claim-token" />
        <p className="text-xs text-muted-foreground">
          The claim token starts a claim through the API instead (see <a className="underline" href="/auth.md">/auth.md</a>). It is also shown only once.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Checkbox id="agent-secret-saved" checked={saved} onCheckedChange={(value) => setSaved(value === true)} />
        <Label htmlFor="agent-secret-saved">I have saved my secret</Label>
      </div>

      <Button type="button" className="w-full" disabled={!saved} onClick={() => onContinue(redirectUrl)}>
        Continue
      </Button>
    </section>
  );
}
