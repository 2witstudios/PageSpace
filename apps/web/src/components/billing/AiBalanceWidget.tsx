'use client';

import { ORGS_ENABLED } from '@pagespace/lib/organizations/orgs-enabled';
import { spendChipModel } from '@pagespace/lib/billing/spend-surface';
import { useConversationSpend } from '@/hooks/useConversationSpend';
import { useSpendContextStore } from '@/stores/useSpendContextStore';
import { SpendSourcePopover } from '@/components/wallets/SpendSourcePopover';
import { CreditBalance } from './CreditBalance';

/**
 * The header's credit chip. Where the conversation in view can spend from more than one source,
 * the spending-from chip replaces the personal-credits chip (Spec SPEND-2, D20.8); everywhere
 * else, and while organizations are dark, it is the personal chip as before.
 */
export function AiBalanceWidget() {
  const active = useSpendContextStore((state) => state.active);
  const popoverOpen = useSpendContextStore((state) => state.popoverOpen);
  const setPopoverOpen = useSpendContextStore((state) => state.setPopoverOpen);
  const { spend, choose } = useConversationSpend(active?.conversationId ?? null, {
    driveId: active?.driveId ?? null,
    isGlobal: active?.isGlobal ?? false,
  });
  const chip = spend ? spendChipModel({ orgsEnabled: ORGS_ENABLED, options: spend.options, resolved: spend.resolved }) : null;

  if (!spend || !chip) return <CreditBalance />;

  const driveName = spend.options.find((o) => o.driveName)?.driveName ?? null;
  return (
    <SpendSourcePopover
      chip={chip}
      options={spend.options}
      selectedWalletId={spend.resolved.kind === 'spend' ? spend.resolved.walletId : spend.chosenWalletId}
      driveName={driveName}
      open={popoverOpen}
      onOpenChange={setPopoverOpen}
      onChoose={(walletId) => choose(walletId)}
    />
  );
}
