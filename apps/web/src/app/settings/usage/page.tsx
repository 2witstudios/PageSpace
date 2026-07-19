'use client';

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ArrowLeft, CheckCircle, AlertTriangle } from 'lucide-react';
import { CreditBalanceCard } from '@/components/billing/CreditBalanceCard';
import { UsageBreakdownCard } from '@/components/billing/UsageBreakdownCard';
import { MachineUsageCard } from '@/components/billing/MachineUsageCard';
import { ConcurrencyCard } from '@/components/billing/ConcurrencyCard';
import { AutomationsCard } from '@/components/billing/AutomationsCard';
import { StorageUsageCard } from '@/components/billing/StorageUsageCard';

export default function UsagePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const creditsParam = searchParams.get('credits');

  useEffect(() => {
    if (creditsParam) {
      const timer = setTimeout(() => {
        router.replace('/settings/usage');
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [creditsParam, router]);

  return (
    <div className="container mx-auto p-6 space-y-8 max-w-4xl">
      <div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push('/settings')}
          className="mb-4"
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Settings
        </Button>
        <div className="text-center space-y-2">
          <h1 className="text-4xl font-bold">Usage</h1>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
            Credits, usage breakdown, automations, and storage
          </p>
        </div>
      </div>

      {creditsParam === 'success' && (
        <Alert className="border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950/20">
          <CheckCircle className="h-4 w-4 text-green-600" />
          <AlertDescription className="text-green-800 dark:text-green-200">
            Credits added! Your top-up balance has been updated.
          </AlertDescription>
        </Alert>
      )}
      {creditsParam === 'canceled' && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            Credit purchase canceled. You can buy credits anytime.
          </AlertDescription>
        </Alert>
      )}

      <CreditBalanceCard />
      <UsageBreakdownCard />
      <MachineUsageCard />
      <ConcurrencyCard />
      <AutomationsCard />
      <StorageUsageCard />
    </div>
  );
}
