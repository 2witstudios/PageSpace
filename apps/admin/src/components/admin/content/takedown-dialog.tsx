'use client';

import { useEffect, useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export type TakedownCategory = 'csam' | 'malware' | 'illegal_other' | 'policy';

const CATEGORY_LABELS: Record<TakedownCategory, string> = {
  csam: 'CSAM',
  malware: 'Malware',
  illegal_other: 'Other illegal content',
  policy: 'Policy (copyright, terms)',
};

export interface TakedownDialogValues {
  category: TakedownCategory;
  reason: string;
  suspendUploader: boolean;
  skipPreservation: boolean;
  skipPreservationReason: string;
}

interface TakedownDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  /** The categories this action accepts. A global takedown never offers `policy`. */
  categories: readonly TakedownCategory[];
  /** Global takedown only: offer "suspend uploader" and "skip preservation". */
  globalOptions?: { uploaderCount: number; uploaderCountIncomplete?: boolean };
  pending: boolean;
  error: string | null;
  onConfirm: (values: TakedownDialogValues) => void;
}

/**
 * The confirmation for every takedown action: a category and a reason are
 * always required, and nothing runs until the admin confirms here.
 */
export function TakedownDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  categories,
  globalOptions,
  pending,
  error,
  onConfirm,
}: TakedownDialogProps) {
  const [category, setCategory] = useState<TakedownCategory | ''>('');
  const [reason, setReason] = useState('');
  const [suspendUploader, setSuspendUploader] = useState(false);
  const [skipPreservation, setSkipPreservation] = useState(false);
  const [skipReason, setSkipReason] = useState('');
  const reasonId = useId();
  const suspendId = useId();
  const skipId = useId();
  const skipReasonId = useId();

  useEffect(() => {
    if (open) {
      setCategory('');
      setReason('');
      setSuspendUploader(false);
      setSkipPreservation(false);
      setSkipReason('');
    }
  }, [open]);

  // CSAM must be preserved before it is deleted; the server refuses a skip, so do not offer one.
  const canSkipPreservation = Boolean(globalOptions) && category !== '' && category !== 'csam';
  const skipping = canSkipPreservation && skipPreservation;
  const valid = category !== '' && reason.trim().length > 0 && (!skipping || skipReason.trim().length > 0);

  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Category</Label>
            <Select value={category} onValueChange={(value) => setCategory(value as TakedownCategory)} disabled={pending}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a category" />
              </SelectTrigger>
              <SelectContent>
                {categories.map((value) => (
                  <SelectItem key={value} value={value}>{CATEGORY_LABELS[value]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor={reasonId}>Reason (recorded on the case and in the audit log)</Label>
            <Input
              id={reasonId}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Report reference, hash-list match, notice number…"
              maxLength={1000}
              disabled={pending}
            />
          </div>

          {globalOptions && (
            <>
              <div className="flex items-start gap-2">
                <input
                  id={suspendId}
                  type="checkbox"
                  checked={suspendUploader}
                  onChange={(e) => setSuspendUploader(e.target.checked)}
                  disabled={pending}
                  className="mt-1 h-4 w-4 shrink-0 accent-primary"
                />
                <div className="min-w-0">
                  <Label htmlFor={suspendId} className="cursor-pointer">
                    Also suspend the uploader{globalOptions.uploaderCount === 1 ? '' : 's'} ({globalOptions.uploaderCount})
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Storage is shared by content hash, so this suspends every account that uploaded these exact bytes.
                    {globalOptions.uploaderCountIncomplete &&
                      ' The count may be low: the AI chat search did not finish. The takedown searches again, and suspends whoever it finds.'}
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-2">
                <input
                  id={skipId}
                  type="checkbox"
                  checked={skipping}
                  onChange={(e) => setSkipPreservation(e.target.checked)}
                  disabled={pending || !canSkipPreservation}
                  className="mt-1 h-4 w-4 shrink-0 accent-primary"
                />
                <div className="min-w-0">
                  <Label htmlFor={skipId} className="cursor-pointer">Delete without preserving a copy</Label>
                  <p className="text-xs text-muted-foreground">
                    {category === 'csam'
                      ? 'Not available for CSAM: it is always preserved before it is deleted.'
                      : 'By default a copy goes to the evidence bucket first. Skipping that is audited with your reason.'}
                  </p>
                </div>
              </div>

              {skipping && (
                <div className="space-y-2">
                  <Label htmlFor={skipReasonId}>Why is no copy needed?</Label>
                  <Input
                    id={skipReasonId}
                    value={skipReason}
                    onChange={(e) => setSkipReason(e.target.value)}
                    maxLength={1000}
                    disabled={pending}
                  />
                </div>
              )}
            </>
          )}

          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={!valid || pending}
            onClick={() => {
              if (category === '') return;
              onConfirm({
                category,
                reason: reason.trim(),
                suspendUploader,
                skipPreservation: skipping,
                skipPreservationReason: skipReason.trim(),
              });
            }}
          >
            {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
