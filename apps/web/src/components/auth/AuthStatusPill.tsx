'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface AuthStatusPillProps {
  tone: 'danger' | 'info';
  children: ReactNode;
}

const DOT_TONE = {
  danger: 'bg-[oklch(0.577_0.245_27)]',
  info: 'bg-[oklch(0.50_0.16_235)]',
} as const;

/**
 * The v3 sign-in status pill: a rounded card with a coloured dot, shown above the
 * sign-in heading for error and notice query params. Used instead of a sonner toast
 * on the Imago-enabled frame only.
 */
export function AuthStatusPill({ tone, children }: AuthStatusPillProps) {
  return (
    <div
      role="status"
      className="mb-6 flex w-full max-w-[400px] items-center gap-2.5 rounded-[10px] border border-[oklch(0.90_0.005_230)] bg-[oklch(0.995_0.002_240)] px-3.5 py-2.5 text-[13px] text-[oklch(0.15_0.01_220)] shadow-[0_8px_24px_rgb(0_0_0/0.08)]"
    >
      <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', DOT_TONE[tone])} />
      <span>{children}</span>
    </div>
  );
}
