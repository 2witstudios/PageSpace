'use client';

import { useEffect, useState } from 'react';
import { spendChipModel } from '@pagespace/lib/billing/spend-surface';
import { useConversationSpend, useDriveSpend } from '@/hooks/useConversationSpend';
import { focusDriveId, useFocus } from '@/lib/dashboard/focus';
import { useSpendContextStore, type SpendContext } from '@/stores/useSpendContextStore';
import { SpendSourcePopover } from '@/components/wallets/SpendSourcePopover';
import { CreditBalance } from './CreditBalance';

/**
 * The header's credit chip. Where the conversation in view can spend from more than one source,
 * the spending-from chip replaces the personal-credits chip (Spec SPEND-2, D20.8); everywhere
 * else it is the personal chip. Inside a drive with
 * no conversation in view (a document, a folder), the chip follows the DRIVE: what a new
 * conversation there would spend, read only — a source is switched per conversation (SPEND-3).
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
  const { spend: conversationSpend, isMissingDraft, choose } = useConversationSpend(target?.conversationId ?? null, {
    driveId: target?.driveId ?? null,
    isGlobal: target?.isGlobal ?? false,
  });
  // A confirmed missing draft may preview its mounted drive. Revalidating an existing
  // conversation must not substitute the drive default for its unresolved chosen source.
  const currentDriveId = focusDriveId(useFocus()) ?? null;
  const previewDriveId = target ? target.driveId : currentDriveId;
  const usePreview = !target || (isMissingDraft && !conversationSpend);
  const { spend: driveSpend } = useDriveSpend(usePreview ? previewDriveId : null);
  const [driveOpen, setDriveOpen] = useState(false);

  // The pinned conversation's surface unmounted (or moved to another conversation): close.
  const pinnedStillMounted = pinned !== null && entries.some((e) => e.conversationId === pinned.conversationId);
  useEffect(() => {
    if (pinned && !pinnedStillMounted) setPinned(null);
  }, [pinned, pinnedStillMounted]);

  if (usePreview) {
    const driveChip = driveSpend ? spendChipModel({ options: driveSpend.options, resolved: driveSpend.resolved }) : null;
    if (!driveSpend || !driveChip) return <CreditBalance />;
    return (
      <SpendSourcePopover
        chip={driveChip}
        options={driveSpend.options}
        selectedWalletId={driveSpend.resolved.kind === 'spend' ? driveSpend.resolved.walletId : null}
        driveName={driveSpend.options.find((o) => o.driveName)?.driveName ?? null}
        open={driveOpen}
        onOpenChange={setDriveOpen}
      />
    );
  }

  const spend = conversationSpend;
  const chip = spend ? spendChipModel({ options: spend.options, resolved: spend.resolved }) : null;
  if (!spend && target?.driveId) return null;
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
