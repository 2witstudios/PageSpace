'use client';

import { SettingsScreen } from '@/ui/settings/settings-screen/settings-screen';
import { AgentAccountsPanel } from '@/retained/components/agent-accounts/AgentAccountsPanel';

/**
 * Personal settings → Agent accounts: API keys the signed-in person's global assistant can use (G2).
 * The same panel as an agent page's Accounts settings, scoped to accounts the person owns, laid out as
 * the account route's screen (C-Account-AgentAccounts): one lede, the accounts, then the add form inline.
 */
export default function AgentAccountsSettingsPage() {
  return (
    <SettingsScreen title="Agent accounts" lede="API keys Imago can use. It refers to an account by name and never sees the key.">
      <AgentAccountsPanel scope={{ kind: 'user' }} layout="page" />
    </SettingsScreen>
  );
}
