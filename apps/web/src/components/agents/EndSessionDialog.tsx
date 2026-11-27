'use client';

/**
 * The one confirm dialog for ending a session — shared by the sidebar's "End
 * session" control and the pane grid's last-pane close, so the two paths that
 * both tear down the same sandbox ask the user the same question (issue
 * #2263, finding 2: closing the last pane used to skip this entirely, while
 * the sidebar's identical act already required it).
 */
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

export interface EndSessionDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Display label, when the caller has one — "this session" otherwise (never an address). */
  sessionName?: string | null;
  onConfirm(): void;
  /** Overrides for a confirm that ends something other than one session (see `EndPreviousSessionsDialog`). */
  title?: string;
  description?: string;
  actionLabel?: string;
}

export default function EndSessionDialog({ open, onOpenChange, sessionName, onConfirm, title, description, actionLabel }: EndSessionDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title ?? `End ${sessionName ? `“${sessionName}”` : 'this session'}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {description ?? 'Its sandbox is stopped and its shells close. Conversations stay in each agent\'s history.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{actionLabel ?? 'End session'}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export interface EndPreviousSessionsDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** How many sessions "End all" will end. */
  count: number;
  onConfirm(): void;
}

/**
 * The confirm for the sidebar's "Previous sessions → End all": the ephemeral
 * sessions from before the drive had a Home env. Each owns its OWN sandbox, so
 * ending them destroys whatever files they hold — said plainly, because that is
 * the one reason they were not ended automatically.
 */
export function EndPreviousSessionsDialog({ open, onOpenChange, count, onConfirm }: EndPreviousSessionsDialogProps) {
  return (
    <EndSessionDialog
      open={open}
      onOpenChange={onOpenChange}
      onConfirm={onConfirm}
      title={`End ${count} previous ${count === 1 ? 'session' : 'sessions'}?`}
      description="Each has its own sandbox, and any files in those sandboxes will be lost. Move anything you want to keep into Home first. Conversations stay in each agent's history."
      actionLabel="End all"
    />
  );
}
