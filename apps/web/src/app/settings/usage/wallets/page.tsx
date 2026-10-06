'use client';

import { notFound, useRouter } from 'next/navigation';
import { ORGS_ENABLED } from '@pagespace/lib/organizations/orgs-enabled';
import { Button } from '@/components/ui/button';
import { ArrowLeft } from 'lucide-react';
import { UsageWallets } from '@/components/wallets/usage/UsageWallets';

/**
 * Settings › Usage › Wallets (Spec UI-10, SPEND-3, SPEND-9, SPEND-10; canvas v9 UsageWallets):
 * everything the person spends from, everything they fund, and their default. Dark while
 * organizations are off.
 */
export default function UsageWalletsPage() {
  if (!ORGS_ENABLED) notFound();
  return <UsageWalletsScreen />;
}

function UsageWalletsScreen() {
  const router = useRouter();
  return (
    <div className="container mx-auto max-w-4xl space-y-8 p-6">
      <div>
        <Button variant="ghost" size="sm" onClick={() => router.push('/settings/usage')} className="mb-4">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to Usage
        </Button>
        <h1 className="text-3xl font-bold">Wallets</h1>
        <p className="text-muted-foreground">Everything your AI usage can spend from, and everything you fund</p>
      </div>
      <UsageWallets />
    </div>
  );
}
