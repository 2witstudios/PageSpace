'use client';

import { useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Check, ChevronDown } from 'lucide-react';
import { spendChoiceAmount, spendChoiceHint, type SpendChipModel, type SurfaceChoice } from '@pagespace/lib/billing/spend-surface';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { orgErrorMessage } from '@/lib/orgs/org-error-copy';
import { cn } from '@/lib/utils';
import { SpendSourceIcon } from './SpendSourceIcon';

interface SpendSourcePopoverProps {
  chip: SpendChipModel;
  options: SurfaceChoice[];
  /** The wallet the next call spends (the gate's preview), or null while it refuses. */
  selectedWalletId: string | null;
  /** The drive the conversation spends in, by name, for the header line. */
  driveName: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (walletId: string) => Promise<void>;
}

/**
 * The header's spending-from chip and its popover (Spec UI-8, SPEND-2, SPEND-3; canvas v9
 * SpendSource). The chip is ONE short token — the source's kind as an icon and a credit count
 * (the icon alone below sm) — so it never widens the header (the wallet's name lives in the
 * popover). Switching here changes the source of the conversation the chip shows — the
 * surface the person last focused, by its explicit id — and it persists for it.
 */
export function SpendSourcePopover({ chip, options, selectedWalletId, driveName, open, onOpenChange, onChoose }: SpendSourcePopoverProps) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="spend-source-chip"
          aria-label={chip.ariaLabel}
          className={cn(
            // Below sm the chip is the source's icon alone (still one token, SPEND-2 on phones);
            // from sm the count joins it. The full name is in the popover and the aria-label.
            'inline-flex h-8 max-w-[8.5rem] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2 text-xs font-medium tabular-nums sm:px-2.5',
            'bg-card text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            chip.tone === 'refused' && 'border-amber-300 text-amber-800 dark:border-amber-700 dark:text-amber-300',
            chip.tone === 'paused' && 'border-dashed text-muted-foreground',
          )}
        >
          <SpendSourceIcon source={chip.source} paused={chip.tone === 'paused'} className="text-muted-foreground" />
          <span className="hidden truncate sm:inline" data-testid="spend-source-chip-text">{chip.text}</span>
          <ChevronDown className="hidden h-3 w-3 shrink-0 text-muted-foreground sm:inline" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(24rem,calc(100vw-2rem))] p-0">
        <SpendSourceOptionsPanel
          options={options}
          selectedWalletId={selectedWalletId}
          driveName={driveName}
          onChoose={onChoose}
          onDone={() => onOpenChange(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

export interface SpendSourceOptionsPanelProps {
  options: SurfaceChoice[];
  selectedWalletId: string | null;
  driveName: string | null;
  onChoose: (walletId: string) => Promise<void>;
  /** Called after a successful switch, or when the person follows the wallets link. */
  onDone: () => void;
}

/** The popover's body: one row per source the person may pick, with who funds it and what is left. */
export function SpendSourceOptionsPanel({ options, selectedWalletId, driveName, onChoose, onDone }: SpendSourceOptionsPanelProps) {
  const [pending, setPending] = useState<string | null>(null);

  const choose = async (walletId: string) => {
    if (walletId === selectedWalletId || pending) return;
    setPending(walletId);
    try {
      await onChoose(walletId);
      onDone();
    } catch (error) {
      toast.error(orgErrorMessage(error, 'The source could not be changed. Try again.'));
    } finally {
      setPending(null);
    }
  };

  return (
    <>
      <div className="border-b px-4 pb-2.5 pt-3.5">
        <p className="text-sm font-semibold">Spending from</p>
        <p className="text-xs text-muted-foreground">
          Your AI usage{driveName ? ` in ${driveName}` : ''} for this conversation. Applies to chat, agents you talk to here, and pages you ask AI to edit.
        </p>
      </div>
      <div role="radiogroup" aria-label="Spending source" className="flex flex-col gap-2 p-3">
        {options.map((option) => {
          const selected = option.walletId === selectedWalletId;
          return (
            <button
              key={option.walletId}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={pending !== null}
              onClick={() => void choose(option.walletId)}
              className={cn(
                'flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
                selected ? 'border-primary bg-primary/10' : 'hover:bg-accent',
                pending === option.walletId && 'opacity-60',
              )}
            >
              <SpendSourceIcon source={option.source} className="mt-0.5 text-muted-foreground" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium">{option.label}</span>
                <span className="text-xs text-muted-foreground">{spendChoiceHint(option)}</span>
              </span>
              <span className="whitespace-nowrap text-sm font-medium tabular-nums">{spendChoiceAmount(option)}</span>
              {selected && <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
      <div className="border-t px-4 pb-3.5 pt-2.5 text-xs text-muted-foreground">
        <Link href="/settings/usage/wallets" className="text-primary hover:underline" onClick={onDone}>
          See your wallets
        </Link>
      </div>
    </>
  );
}
