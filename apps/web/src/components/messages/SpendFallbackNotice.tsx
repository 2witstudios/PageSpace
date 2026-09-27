'use client';

import { ArrowRightLeft } from 'lucide-react';
import { spendFallbackNoticeText } from '@/lib/ai/shared/spend-fallback-notice';

/**
 * SPEND-4: the drive's fallback rule moved this reply to another source; say which, from
 * which, above the reply. Announced once via a polite live region. Renders nothing for a
 * malformed payload (the part travels untyped).
 */
export function SpendFallbackNotice({ data }: { data: unknown }) {
  const text = spendFallbackNoticeText(data);
  if (text === null) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-2.5 py-0.5 mb-1 text-xs text-amber-700 dark:text-amber-300 w-fit"
    >
      <ArrowRightLeft size={12} aria-hidden="true" className="shrink-0" />
      {text}
    </div>
  );
}
