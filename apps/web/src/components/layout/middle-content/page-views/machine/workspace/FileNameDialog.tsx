"use client";

/**
 * FileNameDialog — the single name-input dialog `MachineFileTree` uses for New
 * File, New Folder, and Rename (Machine Files Manager epic, task 11). The
 * app's `RenameDialog`/`MovePageDialog` are page-entity-specific (drive pages,
 * not machine filesystem paths) — this is a small local equivalent rather than
 * a reuse of those.
 *
 * Validation is client-side and minimal: a path segment can't be empty or
 * contain `/` (the route treats `path`/`toPath` as a single segment appended
 * to a parent directory, not a nested path). Deeper failures — a name that
 * already exists, a vanished parent — come back from the mutation itself and
 * are surfaced as a toast by the caller, not from here.
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

export interface FileNameDialogProps {
  open: boolean;
  title: string;
  description?: string;
  /** Pre-filled for Rename; empty for New File / New Folder. */
  initialName?: string;
  submitting?: boolean;
  onCancel: () => void;
  onSubmit: (name: string) => void;
}

function validateName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return 'Name is required';
  if (trimmed.includes('/')) return "Name cannot contain '/'";
  return null;
}

export default function FileNameDialog({
  open,
  title,
  description,
  initialName = '',
  submitting = false,
  onCancel,
  onSubmit,
}: FileNameDialogProps) {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);

  // Re-seed from `initialName` every time the dialog opens — the same instance
  // is reused across New File / New Folder / Rename by the caller.
  useEffect(() => {
    if (open) {
      setName(initialName);
      setError(null);
    }
  }, [open, initialName]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const validationError = validateName(name);
    if (validationError) {
      setError(validationError);
      return;
    }
    onSubmit(name.trim());
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
          <DialogDescription>{description ?? 'A name cannot be empty or contain \'/\'.'}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="grid gap-2 py-2">
            <Label htmlFor="file-name-dialog-input">Name</Label>
            <Input
              id="file-name-dialog-input"
              autoFocus
              value={name}
              onChange={(e) => {
                setName(e.target.value);
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
              {submitting ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
