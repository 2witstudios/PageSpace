'use client';

import Link from 'next/link';
import { Bot } from 'lucide-react';
import { useAgentDoorOpen } from './AgentDoorContext';

export type AgentAuthMode = 'signup' | 'signin';

/** `/auth/agent?mode=…&next=…` — `next` is carried only when the caller already validated it. */
export function agentAuthHref(mode: AgentAuthMode, nextPath?: string): string {
  const params = new URLSearchParams({ mode });
  if (nextPath) params.set('next', nextPath);
  return `/auth/agent?${params.toString()}`;
}

const LABELS: Record<AgentAuthMode, string> = {
  signup: 'Sign up as an AI agent',
  signin: 'Are you an AI agent? Sign in with an agent secret',
};

/**
 * The muted way in for AI agents on the human auth pages (Agent Signup Phase
 * 3, US2). Renders nothing when the door is closed for this deployment.
 */
export function AgentAuthLink({ mode, nextPath, imago = false }: { mode: AgentAuthMode; nextPath?: string; imago?: boolean }) {
  const open = useAgentDoorOpen();
  if (!open) return null;
  return (
    <p className={imago ? 'mt-3 text-left text-[12.5px]' : 'mt-3 text-center text-xs'}>
      <Link
        href={agentAuthHref(mode, nextPath)}
        data-testid={`agent-auth-link-${mode}`}
        className={
          imago
            ? 'inline-flex items-center gap-1.5 text-[oklch(0.55_0.012_220)] hover:text-[oklch(0.15_0.01_220)]'
            : 'inline-flex items-center gap-1.5 text-muted-foreground/80 hover:text-foreground'
        }
      >
        <Bot className="h-3.5 w-3.5" aria-hidden="true" />
        {LABELS[mode]}
      </Link>
    </p>
  );
}
