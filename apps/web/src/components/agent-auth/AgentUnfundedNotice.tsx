'use client';

import Link from 'next/link';
import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

export const AGENT_UNFUNDED_COPY = 'This agent has no AI credits — share your claim link to get funded';

/**
 * Shown in an UNCLAIMED agent's session where a human sees "Verify Email"
 * (Agent Signup Phase 3, US4): an agent has no inbox to verify, and no AI
 * credits until a human claims it. Links to the identity card, which mints the
 * claim link.
 */
export function AgentUnfundedNotice() {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/20"
      asChild
    >
      <Link href="/settings/account#agent-identity" className="hidden sm:flex items-center gap-1.5" title={AGENT_UNFUNDED_COPY} data-testid="agent-unfunded-notice">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <span className="hidden xl:inline text-xs font-medium">{AGENT_UNFUNDED_COPY}</span>
        <span className="xl:hidden text-xs font-medium" aria-hidden="true">No AI credits</span>
      </Link>
    </Button>
  );
}
