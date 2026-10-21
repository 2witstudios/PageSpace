'use client';

import { useEffect, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { formatDollars } from '@pagespace/lib/billing/money-model';
import { Button } from '@/retained/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/retained/components/ui/dialog';

/** The storage add-on as both the personal and the org endpoints describe it. */
export interface StorageAddonState {
  blocks: number;
  entitledBlocks: number;
  graceUntil: string | null;
  currentPeriodEnd: string | null;
  blockBytes: number;
  maxBlocks: number;
  blockPriceCents: number;
}

const GB = 1024 ** 3;
const formatGb = (bytes: number) => `${Math.round(bytes / GB)} GB`;
const formatDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : 'the end of this billing period');

interface StorageAddonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  addon: StorageAddonState;
  /** The plan's own quota, so the dialog can show the new total. */
  baseQuotaBytes: number;
  /** Whose card is charged, for the copy ("your" / "the organization's"). */
  payerLabel: string;
  /** Apply the new block count; resolves when it is applied, rejects with a user-facing message. */
  onSubmit: (blocks: number) => Promise<void>;
}

/**
 * Choose how many 50 GB storage blocks to hold. An increase is charged now (prorated);
 * a decrease takes effect at the end of the billing period, with no refund.
 */
export function StorageAddonDialog({ open, onOpenChange, addon, baseQuotaBytes, payerLabel, onSubmit }: StorageAddonDialogProps) {
  const [target, setTarget] = useState(addon.blocks);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTarget(addon.blocks);
      setError(null);
    }
  }, [open, addon.blocks]);

  const delta = target - addon.blocks;
  const monthlyCents = target * addon.blockPriceCents;
  const totalBytes = baseQuotaBytes + target * addon.blockBytes;

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSubmit(target);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The storage change could not be completed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Extra storage</DialogTitle>
          <DialogDescription>
            Add storage in {formatGb(addon.blockBytes)} blocks at {formatDollars(addon.blockPriceCents)}/month each.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-center gap-4 py-2">
          <Button
            variant="outline"
            size="icon"
            aria-label="Remove a block"
            onClick={() => setTarget((t) => Math.max(0, t - 1))}
            disabled={saving || target <= 0}
          >
            <Minus className="h-4 w-4" />
          </Button>
          <div className="min-w-24 text-center">
            <div className="text-2xl font-semibold">+{formatGb(target * addon.blockBytes)}</div>
            <div className="text-xs text-muted-foreground">{target} {target === 1 ? 'block' : 'blocks'}</div>
          </div>
          <Button
            variant="outline"
            size="icon"
            aria-label="Add a block"
            onClick={() => setTarget((t) => Math.min(addon.maxBlocks, t + 1))}
            disabled={saving || target >= addon.maxBlocks}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        <div className="space-y-1 rounded-md border p-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Total storage</span>
            <span className="font-medium">{formatGb(totalBytes)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Extra storage per month</span>
            <span className="font-medium">{formatDollars(monthlyCents)}</span>
          </div>
        </div>

        <p className="text-sm text-muted-foreground">
          {delta > 0 && `${payerLabel} card is charged now for the rest of this billing period, then ${formatDollars(monthlyCents)}/month with your plan.`}
          {delta < 0 && `You keep the storage you have paid for until ${formatDate(addon.currentPeriodEnd)}. Nothing is refunded, and no files are deleted.`}
          {delta === 0 && target >= addon.maxBlocks && 'Need more? Contact us.'}
        </p>

        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={submit} disabled={saving || delta === 0}>
            {saving ? 'Saving…' : delta > 0 ? `Add ${formatGb(delta * addon.blockBytes)}` : 'Update storage'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
