'use client';

import { useEffect, useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { parseCreditInput } from '@pagespace/lib/billing/wallet-surface';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useEditingStore } from '@/stores/useEditingStore';

interface CreditAmountFieldProps {
  /** Stable id for the editing session (UI refresh protection). */
  editingId: string;
  label: string;
  hint?: string;
  initialCredits?: string;
  actionLabel: string;
  /** Smallest credit count accepted (1 for a top-up or donation, 0 for an allocation). */
  min?: number;
  disabled?: boolean;
  /** Receives whole cents (the money model's conversion); resolves when the write landed. */
  onSubmit: (cents: number) => Promise<void>;
}

/**
 * A credit-count input with its action (UI-9, UI-12): the person types credits ("1,200"), never
 * dollars; the money model converts. While the person edits, the field is registered with the
 * editing store so a background refresh cannot clobber what they are typing.
 */
export function CreditAmountField({ editingId, label, hint, initialCredits = '', actionLabel, min = 0, disabled = false, onSubmit }: CreditAmountFieldProps) {
  const id = useId();
  const [value, setValue] = useState(initialCredits);
  const [pending, setPending] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const startEditing = useEditingStore((s) => s.startEditing);
  const endEditing = useEditingStore((s) => s.endEditing);

  useEffect(() => () => endEditing(editingId), [editingId, endEditing]);
  useEffect(() => {
    if (!useEditingStore.getState().isAnyEditing()) setValue(initialCredits);
  }, [initialCredits]);

  const submit = async () => {
    const parsed = parseCreditInput(value, { min });
    if (!parsed.ok) {
      setInvalid(true);
      return;
    }
    setPending(true);
    try {
      await onSubmit(parsed.cents);
      endEditing(editingId);
    } catch {
      // The caller has already told the person why (its toast); the value stays for a retry.
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Input
            id={id}
            inputMode="numeric"
            value={value}
            disabled={disabled || pending}
            aria-invalid={invalid}
            onFocus={() => startEditing(editingId, 'form', { componentName: 'CreditAmountField' })}
            onBlur={() => {
              if (value === initialCredits) endEditing(editingId);
            }}
            onChange={(e) => {
              setInvalid(false);
              setValue(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
            className="pr-16 tabular-nums"
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">credits</span>
        </div>
        <Button type="button" variant="outline" disabled={disabled || pending || value.trim() === ''} onClick={() => void submit()}>
          {pending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
          {actionLabel}
        </Button>
      </div>
      {invalid ? (
        <p className="text-xs text-destructive">Enter a whole number of credits{min > 0 ? ` (at least ${min})` : ''}.</p>
      ) : (
        hint && <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}
