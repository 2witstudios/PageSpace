import type { WalletStatus } from '@pagespace/lib/billing/wallet-core';
import { walletStatusCopy } from '@pagespace/lib/billing/wallet-surface';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const TONE: Record<WalletStatus, string> = {
  active: 'border-transparent bg-green-100 text-green-800 dark:bg-green-950/50 dark:text-green-300',
  over: 'border-transparent bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
  paused: 'border-dashed bg-muted text-muted-foreground',
};

/** A wallet's status as the canvas names it (WalletStates): Active, Over, Paused. */
export function WalletStatusBadge({ status, className }: { status: WalletStatus; className?: string }) {
  const copy = walletStatusCopy(status);
  return (
    <Badge variant="outline" title={copy.hint} className={cn('justify-center', TONE[status], className)}>
      {copy.label}
    </Badge>
  );
}
