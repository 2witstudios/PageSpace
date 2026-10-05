'use client';

import { useEffect, useState } from 'react';
import { ORGS_ENABLED } from '@pagespace/lib/organizations/orgs-enabled';
import { spendChipModel } from '@pagespace/lib/billing/spend-surface';
import { useConversationSpend } from '@/hooks/useConversationSpend';
import { useSpendContextStore, type SpendContext } from '@/stores/useSpendContextStore';
import { SpendSourcePopover } from '@/components/wallets/SpendSourcePopover';
import { CreditBalance } from './CreditBalance';

/**
 * The header's credit chip. Where the conversation in view can spend from more than one source,
 * the spending-from chip replaces the personal-credits chip (Spec SPEND-2, D20.8); everywhere
 * else, and while organizations are dark, it is the personal chip as before.
 *
 * While its popover is open the chip is PINNED to the conversation it opened on: a background
 * surface changing its conversation, or focus moving, cannot retarget the open list; if that
 * conversation's surface goes away, the popover closes rather than switch someone else's
 * (review #2835 P2-A).
 */
export function AiBalanceWidget() {
  const active = useSpendContextStore((state) => state.active);
  const entries = useSpendContextStore((state) => state.entries);
  const [pinned, setPinned] = useState<SpendContext | null>(null);
  const target = pinned ?? active;
  const { spend, choose } = useConversationSpend(target?.conversationId ?? null, {
    driveId: target?.driveId ?? null,
    isGlobal: target?.isGlobal ?? false,
  });

  // The pinned conversation's surface unmounted (or moved to another conversation): close.
  const pinnedStillMounted = pinned !== null && entries.some((e) => e.conversationId === pinned.conversationId);
  useEffect(() => {
    if (pinned && !pinnedStillMounted) setPinned(null);
  }, [pinned, pinnedStillMounted]);

  const chip = spend ? spendChipModel({ orgsEnabled: ORGS_ENABLED, options: spend.options, resolved: spend.resolved }) : null;
  if (!spend || !chip) return <CreditBalance />;

  const driveName = spend.options.find((o) => o.driveName)?.driveName ?? null;
  return (
    <SpendSourcePopover
      chip={chip}
      options={spend.options}
      selectedWalletId={spend.resolved.kind === 'spend' ? spend.resolved.walletId : spend.chosenWalletId}
      driveName={driveName}
      open={pinned !== null}
      onOpenChange={(open) => setPinned(open ? active : null)}
      onChoose={(walletId) => choose(walletId)}
    />
  );
}
