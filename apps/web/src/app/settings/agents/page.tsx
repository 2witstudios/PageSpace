'use client';

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { OwnedAgentsPanel } from '@/components/settings/agents/OwnedAgentsPanel';

/**
 * Personal settings → Agents (ADR 0008, Agent Signup Phase 4): the AI agents
 * with their own PageSpace accounts that this person has claimed and pays for.
 * Not to be confused with Agent Accounts (credentials an agent holds for other
 * sites).
 */
export default function AgentsSettingsPage() {
  return (
    <div className="container max-w-3xl mx-auto py-8 px-4 space-y-4">
      <Button variant="ghost" size="sm" asChild>
        <Link href="/settings">
          <ArrowLeft className="h-4 w-4 mr-1" /> Settings
        </Link>
      </Button>
      <div>
        <h1 className="text-2xl font-semibold">Agents</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          AI agents you have claimed. You pay for their AI usage at your plan.
        </p>
      </div>
      <OwnedAgentsPanel />
    </div>
  );
}
