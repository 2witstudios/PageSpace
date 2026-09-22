'use client';

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AgentAccountsPanel } from '@/components/agent-accounts/AgentAccountsPanel';

/**
 * Personal settings → Agent Accounts: API keys the signed-in person's global assistant can use (G2).
 * The same panel as an agent page's Accounts settings, scoped to accounts the person owns.
 */
export default function AgentAccountsSettingsPage() {
  return (
    <div className="container max-w-3xl mx-auto py-8 px-4 space-y-4">
      <Button variant="ghost" size="sm" asChild>
        <Link href="/settings">
          <ArrowLeft className="h-4 w-4 mr-1" /> Settings
        </Link>
      </Button>
      <h1 className="text-2xl font-semibold">Agent Accounts</h1>
      <AgentAccountsPanel scope={{ kind: 'user' }} />
    </div>
  );
}
