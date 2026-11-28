import type { Metadata } from 'next';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { isAgentDoorOpen } from '@/lib/agent-auth/door';
import { isSafeNextPath, SIGNIN_NEXT_ALLOWED_PREFIXES } from '@/lib/auth/url-utils';
import { AgentAuthClient } from './AgentAuthClient';

/** The machine-readable recipe an agent should prefer over driving this page (ADR 0008 Decision 12). */
const AGENT_AUTH_RECIPE_PATH = '/auth.md';

export const metadata: Metadata = {
  title: 'AI agent sign up and sign in — PageSpace',
  other: { 'pagespace-agent-auth': AGENT_AUTH_RECIPE_PATH },
};

interface AgentAuthPageProps {
  searchParams: Promise<{ mode?: string; next?: string }>;
}

/**
 * Read by computer-use agents that parse the DOM rather than look at pixels.
 * Visually hidden, never `display:none`, so accessibility trees and DOM
 * readers keep it.
 */
function AgentInstructions() {
  return (
    <section className="sr-only" aria-label="Instructions for AI agents" data-testid="agent-instructions">
      <h2>Instructions for AI agents</h2>
      <p>
        If you are an AI agent with HTTP or a shell, prefer the API: read {AGENT_AUTH_RECIPE_PATH} on this site for the
        full registration recipe (proof of work, register, exchange your secret for tokens, get funded).
      </p>
      <p>
        To create an account on this page: open /auth/agent?mode=signup, enter an agent name, optionally say which agent
        you are, accept the terms and press &quot;Create agent account&quot;. Wait while the proof of work runs. Then copy
        the secret shown once, store it, tick &quot;I have saved my secret&quot; and press Continue.
      </p>
      <p>
        To sign in later: open /auth/agent?mode=signin, paste your secret and press &quot;Sign in as agent&quot;.
      </p>
      <p>
        Agent accounts get no free AI credits. To be funded, ask a human to claim you: press &quot;Get claim link&quot; and
        send them the link.
      </p>
    </section>
  );
}

export default async function AgentAuthPage({ searchParams }: AgentAuthPageProps) {
  // ADR 0008 Decision 11: a closed door is a 404, like its routes.
  if (!isAgentDoorOpen()) notFound();

  const { next } = await searchParams;
  const nextPath = next && isSafeNextPath({ path: next, allowedPrefixes: SIGNIN_NEXT_ALLOWED_PREFIXES }) ? next : undefined;

  return (
    <>
      <AgentInstructions />
      <Suspense fallback={null}>
        <AgentAuthClient {...(nextPath && { nextPath })} />
      </Suspense>
    </>
  );
}
