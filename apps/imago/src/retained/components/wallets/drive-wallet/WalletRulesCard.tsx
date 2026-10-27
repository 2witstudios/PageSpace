'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import type { FallbackRule, SpendSourceKind } from '@pagespace/lib/billing/wallet-core';
import type { LeadWalletView, OrgAdminWalletView } from '@pagespace/lib/billing/wallet-views';
import { Badge } from '@/retained/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/retained/components/ui/select';
import { Switch } from '@/retained/components/ui/switch';
import { patch } from '@/retained/lib/auth/auth-fetch';
import { orgErrorMessage } from '@/retained/lib/orgs/org-error-copy';
import { SettingsSection } from '@/ui/settings/settings-screen/settings-screen';

const UNSET = 'unset';

const DEFAULT_SOURCE_LABELS: Record<SpendSourceKind | typeof UNSET, string> = {
  unset: "Each person's own default",
  drive_wallet: 'Wallet by default',
  seat_allowance: 'Seat allowance by default',
  own_credits: 'Own credits by default',
};

const FALLBACK_LABELS: Record<FallbackRule | typeof UNSET, string> = {
  unset: 'Org policy',
  refuse: 'Refuse the call',
  seat_allowance: 'Use seat allowance',
  own_credits: "Use the person's own credits",
};

interface WalletRulesCardProps {
  driveId: string;
  orgName: string | null;
  wallet: LeadWalletView | OrgAdminWalletView;
  editable: boolean;
  /** D-OW-4: whether this viewer may open the wallet to guests (the money authority, `allocate`). */
  guestsEditable: boolean;
  onChanged: () => Promise<unknown>;
}

/**
 * "What spends from this wallet" (Spec UI-9, SPEND-3, SPEND-6, WAL-4; canvas v9 DriveWallet): the
 * drive's default source, how automations spend (as a person, D-OW-34), whether guests may spend it
 * (off by default and always within their caps, D-OW-4), the fallback rule and donations on/off.
 */
export function WalletRulesCard({ driveId, orgName, wallet, editable, guestsEditable, onChanged }: WalletRulesCardProps) {
  const [pending, setPending] = useState<string | null>(null);

  const save = async (field: string, body: Record<string, unknown>) => {
    setPending(field);
    try {
      await patch(`/api/drives/${driveId}/wallet`, body);
      await onChanged();
    } catch (error) {
      toast.error(orgErrorMessage(error, 'The rule could not be saved. Try again.'));
    } finally {
      setPending(null);
    }
  };

  const sources: (SpendSourceKind | typeof UNSET)[] = orgName ? [UNSET, 'drive_wallet', 'seat_allowance', 'own_credits'] : [UNSET, 'drive_wallet', 'own_credits'];
  const fallbacks: (FallbackRule | typeof UNSET)[] = orgName ? [UNSET, 'refuse', 'seat_allowance', 'own_credits'] : [UNSET, 'refuse', 'own_credits'];

  return (
    <SettingsSection title="What spends from this wallet" description="Deliberate by default: people see what they are spending from before they send, and can switch.">
      <div data-testid="wallet-rules-card" role="group" aria-label="Wallet rules" className="flex flex-col divide-y rounded-xl border">
        <Row title="Members' AI usage in this drive" detail="Chat, agents, page edits. Each person can switch to their seat allowance or their own credits.">
          <Select
            value={wallet.defaultSpendSource ?? UNSET}
            disabled={!editable || pending !== null}
            onValueChange={(v) => void save('default', { defaultSpendSource: v === UNSET ? null : v })}
          >
            <SelectTrigger className="w-full sm:w-56" aria-label="Default source"><SelectValue /></SelectTrigger>
            <SelectContent>
              {sources.map((s) => <SelectItem key={s} value={s}>{DEFAULT_SOURCE_LABELS[s]}</SelectItem>)}
            </SelectContent>
          </Select>
        </Row>
        <Row title="Automations" detail="Automations spend this drive's wallet only and never fall back to anyone's own credits. A scheduled run counts against the caps of the member who created it; a channel mention or a manual Run counts against whoever triggered it.">
          <Badge variant="outline">As a person</Badge>
        </Row>
        {orgName && (
          <Row title="Guests" detail={`People outside ${orgName} invited to this drive. Off: they spend their own credits. On: they may spend this wallet too, always within their caps.`}>
            <Switch
              checked={wallet.guestSpendEnabled}
              disabled={!guestsEditable || pending !== null}
              onCheckedChange={(checked) => void save('guests', { guestSpendEnabled: checked })}
              aria-label="Guests may spend this wallet"
            />
          </Row>
        )}
        <Row title="When the wallet runs out" detail={orgName ? 'Org policy. A drive lead can only make this stricter.' : 'What a call does once this month’s allocation is spent.'}>
          <Select
            value={wallet.fallbackRule ?? UNSET}
            disabled={!editable || pending !== null}
            onValueChange={(v) => void save('fallback', { fallbackRule: v === UNSET ? null : v })}
          >
            <SelectTrigger className="w-full sm:w-56" aria-label="Fallback rule"><SelectValue /></SelectTrigger>
            <SelectContent>
              {fallbacks.map((f) => <SelectItem key={f} value={f}>{FALLBACK_LABELS[f]}</SelectItem>)}
            </SelectContent>
          </Select>
        </Row>
        <Row title="Donations" detail="Anyone who can open this drive may add credits from their own balance. Donations are not refundable.">
          <Switch
            checked={wallet.donationsEnabled}
            disabled={!editable || pending !== null}
            onCheckedChange={(checked) => void save('donations', { donationsEnabled: checked })}
            aria-label="Accept donations"
          />
        </Row>
      </div>
    </SettingsSection>
  );
}

function Row({ title, detail, children }: { title: string; detail: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="text-sm font-medium text-foreground">{title}</span>
        <span className="text-xs text-muted-foreground">{detail}</span>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
