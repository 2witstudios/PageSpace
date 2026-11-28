import { Building2, Folder, PauseCircle, Sparkles, Wallet } from 'lucide-react';
import type { SpendSourceKind } from '@pagespace/lib/billing/wallet-core';
import { cn } from '@/lib/utils';

/**
 * The icon that names a source's KIND on the chip, strip and popover (canvas v9 SpendSource):
 * folder = the drive's wallet, org mark = a seat allowance, sparkle = own credits. A paused
 * source shows the pause mark instead; no source (the person must choose) a plain wallet.
 */
export function SpendSourceIcon({ source, paused = false, className }: { source: SpendSourceKind | null; paused?: boolean; className?: string }) {
  const Icon = paused ? PauseCircle : source === 'drive_wallet' ? Folder : source === 'seat_allowance' ? Building2 : source === 'own_credits' ? Sparkles : Wallet;
  return <Icon className={cn('h-3.5 w-3.5 shrink-0', className)} aria-hidden="true" />;
}
