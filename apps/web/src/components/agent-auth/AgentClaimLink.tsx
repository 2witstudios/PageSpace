'use client';

import { useState } from 'react';
import { Link2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApiRequestError } from '@/lib/auth/auth-fetch';
import { CopyValueButton } from './CopyValueButton';
import { requestAgentClaimLink, type AgentClaimLink as ClaimLink } from './agent-claim-client';

type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; link: ClaimLink }
  | { status: 'error'; message: string };

function describeFailure(error: unknown): string {
  if (error instanceof ApiRequestError && error.status === 409) return 'This agent already has an owner.';
  if (error instanceof ApiRequestError && error.status === 429) return 'Too many claim links requested. Try again in a few minutes.';
  return 'Could not create a claim link. Try again.';
}

/**
 * "Get claim link": mints a short-lived link a human opens to claim this agent
 * and pay for its AI usage (ADR 0008 Decision 8). Shared by the post-signup
 * reveal card and the Settings identity card.
 */
export function AgentClaimLink({ buttonLabel = 'Get claim link' }: { buttonLabel?: string }) {
  const [state, setState] = useState<State>({ status: 'idle' });

  const request = async () => {
    setState({ status: 'loading' });
    try {
      setState({ status: 'ready', link: await requestAgentClaimLink() });
    } catch (error) {
      setState({ status: 'error', message: describeFailure(error) });
    }
  };

  if (state.status === 'ready') {
    const minutes = Math.round(state.link.expires_in / 60);
    return (
      <div className="space-y-2" data-testid="agent-claim-link">
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs" data-testid="agent-claim-url">
            {state.link.verification_uri_complete}
          </code>
          <CopyValueButton value={state.link.verification_uri_complete} label="Copy claim link" />
        </div>
        <p className="text-xs text-muted-foreground">
          Send this link to the human who will fund you. It works for {minutes} minutes; they sign in, confirm code{' '}
          <span className="font-mono">{state.link.user_code}</span>, and pay for your AI usage from then on.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Button type="button" variant="outline" size="sm" onClick={request} disabled={state.status === 'loading'}>
        {state.status === 'loading' ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Link2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />}
        {buttonLabel}
      </Button>
      {state.status === 'error' && <p role="alert" className="text-xs text-destructive">{state.message}</p>}
    </div>
  );
}
