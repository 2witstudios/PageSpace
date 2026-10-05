'use client';

import { useEffect, useState } from 'react';
import { ORGS_ENABLED } from '@pagespace/lib/organizations/orgs-enabled';
import { composerStripModel } from '@pagespace/lib/billing/spend-surface';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useConversationSpend } from '@/hooks/useConversationSpend';
import { useSpendContextStore, type SpendContext } from '@/stores/useSpendContextStore';
import { cn } from '@/lib/utils';
import { SpendSourceIcon } from './SpendSourceIcon';
import { SpendSourceOptionsPanel } from './SpendSourcePopover';

/**
 * Make this conversation the one the header's spending-from chip speaks for (UI-8), while the
 * surface is mounted. Nothing registers while organizations are dark.
 */
export function useSpendContextRegistration(context: SpendContext | null): void {
  const register = useSpendContextStore((state) => state.register);
  const conversationId = context?.conversationId ?? null;
  const driveId = context?.driveId ?? null;
  const isGlobal = context?.isGlobal ?? false;
  const hasMessages = context?.hasMessages ?? false;
  useEffect(() => {
    if (!ORGS_ENABLED || !conversationId) return;
    return register({ conversationId, driveId, isGlobal, hasMessages });
  }, [register, conversationId, driveId, isGlobal, hasMessages]);
}

/**
 * The strip above the composer before a conversation's first message (Spec SPEND-2; canvas v9
 * SpendSource): which source this conversation will spend, what is left, and a Change control
 * that opens the same options as the header chip (at every width; the chip hides below sm).
 * Renders nothing with one source, once the conversation has messages, or while orgs are dark.
 */
export function ComposerSpendStrip({ conversationId, driveId, isGlobal, hasMessages, className }: SpendContext & { className?: string }) {
  useSpendContextRegistration({ conversationId, driveId, isGlobal, hasMessages });
  const { spend, choose } = useConversationSpend(conversationId, { driveId, isGlobal });
  const [open, setOpen] = useState(false);
  const strip = spend ? composerStripModel({ orgsEnabled: ORGS_ENABLED, options: spend.options, resolved: spend.resolved, hasMessages }) : null;
  if (!spend || !strip) return null;

  const resolvedWalletId = spend.resolved.kind === 'spend' ? spend.resolved.walletId : null;
  const selected = resolvedWalletId ? spend.options.find((o) => o.walletId === resolvedWalletId) ?? null : null;
  return (
    <div
      data-testid="composer-spend-strip"
      className={cn(
        'flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs',
        strip.tone === 'refused' ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200' : 'bg-muted/60 text-foreground',
        className,
      )}
    >
      <SpendSourceIcon source={selected?.source ?? null} className="text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">
        {strip.label && strip.tone === 'refused' ? (
          <>
            <b className="font-semibold">{strip.label}</b>: {strip.detail}
          </>
        ) : strip.label ? (
          <>
            Spending from <b className="font-semibold">{strip.label}</b> · {strip.detail}
          </>
        ) : (
          strip.detail
        )}
      </span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" className="shrink-0 font-medium text-primary hover:underline">
            {strip.label && strip.tone !== 'refused' ? 'Change' : 'Choose'}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" side="top" className="w-[min(24rem,calc(100vw-2rem))] p-0">
          <SpendSourceOptionsPanel
            options={spend.options}
            selectedWalletId={selected?.walletId ?? spend.chosenWalletId}
            driveName={spend.options.find((o) => o.driveName)?.driveName ?? null}
            onChoose={(walletId) => choose(walletId)}
            onDone={() => setOpen(false)}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
