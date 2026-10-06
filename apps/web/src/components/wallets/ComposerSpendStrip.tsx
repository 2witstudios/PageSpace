'use client';

import { useState } from 'react';
import { ORGS_ENABLED } from '@pagespace/lib/organizations/orgs-enabled';
import { composerStripModel } from '@pagespace/lib/billing/spend-surface';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useConversationSpend } from '@/hooks/useConversationSpend';
import type { SpendContext } from '@/stores/useSpendContextStore';
import { cn } from '@/lib/utils';
import { SpendSourceIcon } from './SpendSourceIcon';
import { SpendSourceOptionsPanel } from './SpendSourcePopover';

/**
 * The strip above the composer before a conversation's first message (Spec SPEND-2; canvas v9
 * SpendSource): which source this conversation will spend, what is left, and a Change control
 * that opens the same options as the header chip (at every width; the chip hides below sm).
 * Renders nothing with one source, once the conversation has messages, or while orgs are dark.
 * It reads and writes exactly the conversation it is given (its surface's), never the header's.
 */
export function ComposerSpendStrip({ conversationId, driveId, isGlobal, hasMessages, persistentBelowLg = false, className }: SpendContext & {
  hasMessages: boolean;
  /**
   * Keep the strip after the first message below lg. For a surface that covers the header chip
   * there (the right sidebar is a modal sheet below lg), so the source stays switchable from
   * inside it mid-conversation (review #2835 P3-B).
   */
  persistentBelowLg?: boolean;
  className?: string;
}) {
  const { spend, choose } = useConversationSpend(conversationId, { driveId, isGlobal });
  const [open, setOpen] = useState(false);
  const stayBelowLg = persistentBelowLg && hasMessages;
  const strip = spend ? composerStripModel({ orgsEnabled: ORGS_ENABLED, options: spend.options, resolved: spend.resolved, hasMessages: hasMessages && !stayBelowLg }) : null;
  if (!spend || !strip) return null;

  const resolvedWalletId = spend.resolved.kind === 'spend' ? spend.resolved.walletId : null;
  const selected = resolvedWalletId ? spend.options.find((o) => o.walletId === resolvedWalletId) ?? null : null;
  return (
    <div
      data-testid="composer-spend-strip"
      className={cn(
        'flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs',
        stayBelowLg && 'lg:hidden',
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
