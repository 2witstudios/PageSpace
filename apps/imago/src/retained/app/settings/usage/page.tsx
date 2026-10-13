'use client';

import { useEffect } from 'react';
import useSWR from 'swr';
import { useRouter, useSearchParams } from '@/retained-adapters/navigation';
import Link from '@/retained-adapters/link';
import { Alert, AlertDescription } from '@/retained/components/ui/alert';
import { CheckCircle, AlertTriangle } from 'lucide-react';
import { useBillingVisibility } from '@/retained/hooks/useBillingVisibility';
import { fetchWithAuth } from '@/retained/lib/auth/auth-fetch';
import { CreditBalanceCard } from '@/retained/components/billing/CreditBalanceCard';
import { UsageBreakdownCard } from '@/retained/components/billing/UsageBreakdownCard';
import { AgentSessionUsageCard } from '@/retained/components/billing/AgentSessionUsageCard';
import { EnvironmentUsageCard } from '@/retained/components/billing/EnvironmentUsageCard';
import { ConcurrencyCard } from '@/retained/components/billing/ConcurrencyCard';
import { AutomationsCard } from '@/retained/components/billing/AutomationsCard';
import {
  SettingsGroup,
  SettingsRow,
  SettingsScreen,
  SettingsSection,
} from '@/ui/settings/settings-screen/settings-screen';

interface StorageSummary {
  quota: {
    formattedUsed: string;
    formattedQuota: string;
  };
}

const storageFetcher = async (url: string): Promise<StorageSummary> => {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);
  return response.json();
};

/** The storage entry: a link row to the storage screen, with the used and total space. */
function StorageLinkRow() {
  const { data } = useSWR<StorageSummary>('/api/storage/info', storageFetcher, {
    revalidateOnFocus: false,
  });

  return (
    <SettingsGroup label="Storage">
      <SettingsRow
        label={<Link href="/account/storage" className="hover:underline">Storage</Link>}
        hint={data ? `${data.quota.formattedUsed} of ${data.quota.formattedQuota} used` : undefined}
      >
        <Link href="/account/storage" className="text-sm text-accent-deep hover:underline">
          Details →
        </Link>
      </SettingsRow>
    </SettingsGroup>
  );
}

export default function UsagePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { showBilling } = useBillingVisibility();
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
    <SettingsScreen
      title="Usage"
      lede="Your personal credits, where they went, and the automations that spend them."
    >
      {showBilling && creditsParam === 'success' && (
        <Alert className="border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950/20">
          <CheckCircle className="h-4 w-4 text-green-600" />
          <AlertDescription className="text-green-800 dark:text-green-200">
            Credits added! Your top-up balance has been updated.
          </AlertDescription>
        </Alert>
      )}
      {showBilling && creditsParam === 'canceled' && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            Credit purchase canceled. You can buy credits anytime.
          </AlertDescription>
        </Alert>
      )}

      <CreditBalanceCard />
      <UsageBreakdownCard />

      <SettingsSection
        title="Agent sandboxes"
        description="Agent sandbox runtime and cost this period, for sessions that spent your own credits."
      >
        <AgentSessionUsageCard />
        <EnvironmentUsageCard />
        <ConcurrencyCard />
      </SettingsSection>

      <AutomationsCard />
      <StorageLinkRow />
    </SettingsScreen>
  );
}
