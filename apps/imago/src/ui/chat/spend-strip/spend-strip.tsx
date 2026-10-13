'use client';

import type { ReactNode } from 'react';
import useSWR from 'swr';
import { useSocketEvent } from '@/realtime/realtime-provider';
import { renderIcon } from '../../components/icon/icon.render';
import { CREDITS, spendSourceOf } from './spend-strip-model';

/** The 28px strip above the composer (SPEC v3 "spend strip"). */
export const spendStripClass = 'mx-2 flex h-spend-strip flex-none items-center gap-2 px-1 text-xs text-ink-muted';

/**
 * "Spending from **Your credits** · 612 credits left" (IMC-2.4), live with the balance: a
 * settled call emits credits:updated. Change, and the wallet and seat sources it picks
 * between, arrive with the orgs branch (IMC-2.5, IMC-8.18).
 */
export function SpendStrip(): ReactNode {
  const { data, mutate } = useSWR<unknown>(CREDITS);
  useSocketEvent('credits:updated', () => void mutate());
  const source = spendSourceOf(data);
  if (source === null) return null;
  return (
    <div className={spendStripClass} role="status" aria-label="Spending from">
      {renderIcon({ name: 'wallet', size: 13 })}
      <span className="min-w-0 flex-1 truncate">
        Spending from <strong className="font-semibold text-ink">{source.label}</strong> · {source.left}
      </span>
    </div>
  );
}
