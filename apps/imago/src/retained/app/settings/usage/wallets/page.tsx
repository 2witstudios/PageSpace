'use client';

import { UsageWallets } from '@/retained/components/wallets/usage/UsageWallets';
import { SettingsScreen } from '@/ui/settings/settings-screen/settings-screen';

/**
 * Settings › Usage › Wallets (Spec UI-10, SPEND-3, SPEND-9, SPEND-10; canvas v9 UsageWallets):
 * everything the person spends from, everything they fund, and their default.
 */
export default function UsageWalletsPage() {
  return (
    <SettingsScreen title="Wallets" lede="Everything your AI usage can spend from, and everything you fund.">
      <UsageWallets />
    </SettingsScreen>
  );
}
