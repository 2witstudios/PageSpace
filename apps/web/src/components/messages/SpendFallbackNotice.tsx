'use client';

import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { spendFallbackNoticeText } from '@/lib/ai/shared/spend-fallback-notice';
import { useConversationSpend } from '@/hooks/useConversationSpend';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SpendSourceOptionsPanel } from '@/components/wallets/SpendSourcePopover';
import { useSpendSurface } from '@/components/wallets/SpendSurface';

/**
 * SPEND-4: the drive's fallback rule moved this reply to another source; say which, from
 * which (by the wallet's name when the conversation knows it), above the reply. Its Change
 * opens the sources of THIS conversation — the surface the reply is rendered in — at every
 * width (review #2835 P1-1, P2-2). Announced once via a polite live region. Renders nothing
 * for a malformed payload (the part travels untyped).
 */
export function SpendFallbackNotice({ data }: { data: unknown }) {
  const surface = useSpendSurface();
  const [open, setOpen] = useState(false);
  const { spend, choose } = useConversationSpend(surface?.conversationId ?? null, {
    driveId: surface?.driveId ?? null,
    isGlobal: surface?.isGlobal ?? false,
  });
  const from = typeof data === 'object' && data !== null ? (data as Record<string, unknown>).from : null;
  const fromLabel = spend?.options.find((o) => o.source === from)?.label ?? null;
  const text = spendFallbackNoticeText(data, fromLabel);
  if (text === null) return null;
  const selectedWalletId = spend?.resolved.kind === 'spend' ? spend.resolved.walletId : spend?.chosenWalletId ?? null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-1 inline-flex w-fit flex-wrap items-center gap-1.5 rounded-md bg-muted px-2.5 py-1 text-xs text-muted-foreground"
    >
      <ArrowRight size={12} aria-hidden="true" className="shrink-0" />
      <span>{text}</span>
      {spend && spend.options.length > 1 && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button type="button" className="ml-1 font-medium text-primary hover:underline">
              Change
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[min(24rem,calc(100vw-2rem))] p-0">
            <SpendSourceOptionsPanel
              options={spend.options}
              selectedWalletId={selectedWalletId}
              driveName={spend.options.find((o) => o.driveName)?.driveName ?? null}
              onChoose={(walletId) => choose(walletId)}
              onDone={() => setOpen(false)}
            />
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
