'use client';

import { ArrowRight } from 'lucide-react';
import { spendFallbackNoticeText } from '@/lib/ai/shared/spend-fallback-notice';
import { useConversationSpend } from '@/hooks/useConversationSpend';
import { useSpendContextStore } from '@/stores/useSpendContextStore';

/**
 * SPEND-4: the drive's fallback rule moved this reply to another source; say which, from
 * which (by the wallet's name when the conversation in view knows it), above the reply, with
 * a Change control that opens the header's spending-from popover. Announced once via a polite
 * live region. Renders nothing for a malformed payload (the part travels untyped).
 */
export function SpendFallbackNotice({ data }: { data: unknown }) {
  const active = useSpendContextStore((state) => state.active);
  const setPopoverOpen = useSpendContextStore((state) => state.setPopoverOpen);
  const { spend } = useConversationSpend(active?.conversationId ?? null, {
    driveId: active?.driveId ?? null,
    isGlobal: active?.isGlobal ?? false,
  });
  const from = typeof data === 'object' && data !== null ? (data as Record<string, unknown>).from : null;
  const fromLabel = spend?.options.find((o) => o.source === from)?.label ?? null;
  const text = spendFallbackNoticeText(data, fromLabel);
  if (text === null) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-1 inline-flex w-fit items-center gap-1.5 rounded-md bg-muted px-2.5 py-1 text-xs text-muted-foreground"
    >
      <ArrowRight size={12} aria-hidden="true" className="shrink-0" />
      <span>{text}</span>
      {spend && spend.options.length > 1 && (
        <button
          type="button"
          onClick={() => setPopoverOpen(true)}
          className="ml-1 hidden font-medium text-primary hover:underline sm:inline"
        >
          Change
        </button>
      )}
    </div>
  );
}
