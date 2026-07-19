"use client";

/**
 * DestinationPathDialog — the single destination-path dialog `MachineFileTree`
 * uses for Move and Copy (Machine Files Manager epic, task 12). Unlike
 * `FileNameDialog` (a single path SEGMENT appended to a fixed parent), this
 * dialog's input is the FULL destination path, relative to the scope root,
 * INCLUDING the item's name — e.g. moving `src/old.ts` into a sibling folder
 * `lib` under the same name means entering `lib/old.ts`, not just `lib`. That
 * is the one semantic the caller commits to: `toPath` sent to the PATCH verb
 * is exactly what's typed here, never `destinationDir + '/' + currentName`.
 * The field is prefilled with the item's current PARENT directory as an
 * editing starting point — the item's name is deliberately left for the user
 * to type (or change, to rename in the same step). Submitting the prefilled
 * value unedited lands on the parent directory's own path, which the mutation
 * itself rejects (typically `already_exists`, since a directory of that name
 * is already there) — an immediate, legible failure rather than a silent
 * wrong move.
 *
 * Validation is client-side and minimal: the entered path can't be empty
 * (this also blocks landing on the scope root, which the route rejects on its
 * own). Deeper failures — the destination already existing, the source having
 * vanished — come back from the mutation itself and are surfaced as a toast
 * by the caller, not from here.
 */

import { useEffect, useState, type FormEvent } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface DestinationPathDialogProps {
  open: boolean;
  /** 'Move' or 'Copy' — also drives the submit button's label. */
  title: 'Move' | 'Copy';
  /** Prefilled destination path — the item's current PARENT directory, not its full path (see module doc). */
  initialPath: string;
  submitting?: boolean;
  onCancel: () => void;
  onSubmit: (path: string) => void;
}

function validatePath(path: string): string | null {
  if (path.trim().length === 0) return 'Destination path is required';
  return null;
}

export default function DestinationPathDialog({
  open,
  title,
  initialPath,
  submitting = false,
  onCancel,
  onSubmit,
}: DestinationPathDialogProps) {
  const [path, setPath] = useState(initialPath);
  const [error, setError] = useState<string | null>(null);

  // Re-seed from `initialPath` every time the dialog opens — the same instance
  // is reused across Move and Copy by the caller.
  useEffect(() => {
    if (open) {
      setPath(initialPath);
      setError(null);
    }
  }, [open, initialPath]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const validationError = validatePath(path);
    if (validationError) {
      setError(validationError);
      return;
    }
    onSubmit(path.trim());
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Enter the full destination path, relative to the scope root, including the name — e.g. folder/name.ext.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="grid gap-2 py-2">
            <Label htmlFor="destination-path-dialog-input">Destination path</Label>
            <Input
              id="destination-path-dialog-input"
              autoFocus
              value={path}
              onChange={(e) => {
                setPath(e.target.value);
                setError(null);
              }}
              disabled={submitting}
            />
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? (title === 'Move' ? 'Moving…' : 'Copying…') : title}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
