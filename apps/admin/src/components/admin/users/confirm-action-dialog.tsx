'use client';

import { useEffect, useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface ConfirmActionValues {
  reason: string;
  checked: boolean;
}

interface ConfirmActionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  /** Require a non-empty reason (recorded in the audit trail). Default true. */
  requireReason?: boolean;
  reasonLabel?: string;
  reasonPlaceholder?: string;
  /** When set, the user must type this exact string to enable the confirm button. */
  typedConfirmation?: { expected: string; label: string };
  /** Optional checkbox, e.g. "Cancel immediately". */
  checkbox?: { label: string; description?: string };
  pending?: boolean;
  error?: string | null;
  onConfirm: (values: ConfirmActionValues) => void;
}

/**
 * The one confirmation idiom for dangerous admin actions: a real dialog
 * (never window.confirm), a mandatory reason that lands in the tamper-evident
 * audit trail, and optional typed confirmation for irreversible operations.
 */
export function ConfirmActionDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive = true,
  requireReason = true,
  reasonLabel = 'Reason (recorded in the audit log)',
  reasonPlaceholder = 'Why are you taking this action?',
  typedConfirmation,
  checkbox,
  pending = false,
  error,
  onConfirm,
}: ConfirmActionDialogProps) {
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [checked, setChecked] = useState(false);
  const reasonId = useId();
  const typedId = useId();
  const checkboxId = useId();

  useEffect(() => {
    if (open) {
      setReason('');
      setTyped('');
      setChecked(false);
    }
  }, [open]);

  const reasonValid = !requireReason || reason.trim().length > 0;
  const typedValid = !typedConfirmation || typed === typedConfirmation.expected;
  const canConfirm = reasonValid && typedValid && !pending;

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
          {requireReason && (
            <div className="space-y-2">
              <Label htmlFor={reasonId}>{reasonLabel}</Label>
              <Input
                id={reasonId}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={reasonPlaceholder}
                maxLength={500}
                disabled={pending}
              />
            </div>
          )}

          {typedConfirmation && (
            <div className="space-y-2">
              <Label htmlFor={typedId}>{typedConfirmation.label}</Label>
              <Input
                id={typedId}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={typedConfirmation.expected}
                autoComplete="off"
                disabled={pending}
              />
            </div>
          )}

          {checkbox && (
            <div className="flex items-start gap-2">
              <input
                id={checkboxId}
                type="checkbox"
                checked={checked}
                onChange={(e) => setChecked(e.target.checked)}
                disabled={pending}
                className="mt-1 h-4 w-4 shrink-0 accent-primary"
              />
              <div className="min-w-0">
                <Label htmlFor={checkboxId} className="cursor-pointer">{checkbox.label}</Label>
                {checkbox.description && (
                  <p className="text-xs text-muted-foreground">{checkbox.description}</p>
                )}
              </div>
            </div>
          )}

          {error && (
            <p className="text-sm text-destructive" role="alert">{error}</p>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            disabled={!canConfirm}
            onClick={() => onConfirm({ reason: reason.trim(), checked })}
          >
            {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
