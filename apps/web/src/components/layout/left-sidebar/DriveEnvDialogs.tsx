'use client';

/**
 * The three dialogs an environment's management needs — the naming one, and the
 * two destructive ones.
 *
 * They live together because their COPY is the feature. An environment is a
 * drive's shared, persistent filesystem: everyone in the drive works on the
 * same disk, so both destructive verbs destroy other people's work as well as
 * the caller's, and neither is recoverable. What each dialog has to do, then,
 * is name the consequence in the words a user would use — "everything in it,
 * for everyone in this drive" — rather than ask a generic "are you sure?".
 *
 * Every one of them registers with `useEditingStore` while open
 * (`useEditingSession`), which is the repo rule for a surface holding text the
 * user typed: a background revalidation or an auth refresh landing mid-type
 * must not tear the dialog down under them.
 */

import { useEffect, useId, useRef, useState } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MAX_DRIVE_ENV_NAME_LENGTH } from '@pagespace/lib/drive-envs/env-contract';
import { useEditingSession } from '@/stores/useEditingSession';

/**
 * Rename — the only edit an environment has (it has exactly one editable
 * attribute and there is no kind to choose; the epic deleted the enum rather
 * than never writing it, see `env-contract.ts`).
 *
 * It used to create one too. CREATION now lives in the spawn palette, as a step
 * in the same Raycast-style selector that offers environments as somewhere to
 * run — so this dialog no longer carries a mode, and the sidebar no longer
 * carries the icon button that opened it.
 *
 * `onSubmit` answers what should happen to the dialog, not whether the write
 * succeeded — `'retry'` keeps it open with the user's text intact. That exists
 * for exactly one refusal: a name already taken in the drive, which is the most
 * likely failure and the only one retyping fixes. Everything else closes.
 */
export function DriveEnvNameDialog({
  open,
  onOpenChange,
  initialName,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The current name. */
  initialName?: string;
  onSubmit: (name: string) => Promise<'done' | 'retry'>;
}) {
  const [name, setName] = useState(initialName ?? '');
  const [submitting, setSubmitting] = useState(false);
  const inputId = useId();

  // Seeded on the OPEN TRANSITION, not on every `initialName` change — and the
  // ref is what makes that true. `initialName` is the environment's CURRENT
  // name, so it moves whenever the listing revalidates (a teammate renaming the
  // same environment, a refetch after some unrelated write). With it in the
  // dependency list, any such revalidation while this dialog is open would
  // overwrite what the user had typed. Reading `open`'s previous value instead
  // means the seed happens exactly once per opening, which is what the create
  // and rename flows both actually want.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) setName(initialName ?? '');
    wasOpen.current = open;
  }, [open, initialName]);

  useEditingSession(`drive-env-name-${inputId}`, open, 'form', { componentName: 'DriveEnvNameDialog' });

  const trimmed = name.trim();
  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      if ((await onSubmit(trimmed)) === 'done') onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename environment</DialogTitle>
          <DialogDescription>
            Sessions running inside it are unaffected — the name is a label, not an address.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor={inputId} className="text-right">
                Name
              </Label>
              <Input
                id={inputId}
                value={name}
                maxLength={MAX_DRIVE_ENV_NAME_LENGTH}
                onChange={(event) => setName(event.target.value)}
                className="col-span-3"
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={submitting || trimmed.length === 0}>
              {submitting ? 'Renaming…' : 'Rename'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Delete, in two questions rather than one.
 *
 * The first is the ordinary confirm. The server REFUSES that one while sessions
 * are live inside the environment (409), and the second question is what the
 * refusal escalates to: forcing is a materially different act — it ends other
 * people's running sessions before it destroys the disk — so it gets its own
 * confirm, its own button label, and a sentence naming both halves. `?force=`
 * is never sent by the first press, and the escalation is only ever reached by
 * the server saying it is needed.
 *
 * `liveSessionCount` is the SERVER's count, not the sidebar's: this listing is
 * scoped to the viewer's own sessions, so a teammate's session running in the
 * environment is invisible here and is exactly the case the warning exists for.
 */
export function DeleteDriveEnvDialog({
  open,
  onOpenChange,
  envName,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  envName: string;
  /** Resolves to the live-session count when the server refused; null once it is done. */
  onDelete: (options: { force: boolean }) => Promise<{ blockedByLiveSessions: number } | null>;
}) {
  const [liveSessionCount, setLiveSessionCount] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Every re-open starts at the first question. Without this a dialog that was
  // escalated, cancelled, and reopened would offer the force button up front.
  useEffect(() => {
    if (open) setLiveSessionCount(null);
  }, [open]);

  const run = async (force: boolean) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const refusal = await onDelete({ force });
      if (refusal) {
        setLiveSessionCount(refusal.blockedByLiveSessions);
        return;
      }
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  const forcing = liveSessionCount !== null;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {forcing ? `End ${liveSessionCount === 1 ? 'a session' : 'sessions'} and delete “${envName}”?` : `Delete “${envName}”?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {forcing
              ? `${liveSessionCount} ${liveSessionCount === 1 ? 'session is' : 'sessions are'} still running in this environment. Deleting it now ends ${liveSessionCount === 1 ? 'that session' : 'those sessions'} and destroys the shared filesystem — every file in it, for everyone in this drive. This cannot be undone.`
              : 'Its machine is torn down and its filesystem is destroyed — every file in it, for everyone in this drive. This cannot be undone. Conversations from sessions that ran inside it stay in each agent’s history.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
          {/* `onSelect`-preventing wrapper is unnecessary here: the action's own
              handler keeps the dialog open by not calling `onOpenChange`, and
              radix closes on click, so the escalation uses a plain button. */}
          <Button
            type="button"
            variant="destructive"
            disabled={submitting}
            onClick={() => void run(forcing)}
          >
            {submitting
              ? 'Deleting…'
              : forcing
                ? `End ${liveSessionCount === 1 ? 'session' : 'sessions'} and delete`
                : 'Delete environment'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Rebuild — the only verb that replaces an environment's machine.
 *
 * WIPE TO BLANK is the founder-ratified meaning, and the copy says exactly
 * that: the environment keeps its id, its name and its address, and keeps
 * nothing else. It is the answer to a machine past saving, so the dialog names
 * both what survives and what does not, in that order.
 */
export function RebuildDriveEnvDialog({
  open,
  onOpenChange,
  envName,
  onRebuild,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  envName: string;
  onRebuild: () => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Rebuild “{envName}”?</AlertDialogTitle>
          <AlertDialogDescription>
            The environment comes back BLANK. Its machine is destroyed and a new, empty one takes its
            place — every file, package and setting in it is gone, for everyone in this drive, and
            nothing is restored. The environment keeps its name, so anything pointed at it still
            finds it. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={submitting}
            onClick={async (event) => {
              event.preventDefault();
              setSubmitting(true);
              try {
                await onRebuild();
                onOpenChange(false);
              } finally {
                setSubmitting(false);
              }
            }}
          >
            {submitting ? 'Rebuilding…' : 'Rebuild to blank'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
