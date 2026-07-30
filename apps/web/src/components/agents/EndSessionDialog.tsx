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
  /** Disables both actions while the DELETE is in flight. */
  isEnding: boolean;
  onConfirm(): void;
}

export default function EndSessionDialog({ open, onOpenChange, sessionName, isEnding, onConfirm }: EndSessionDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>End {sessionName ? `“${sessionName}”` : 'this session'}?</AlertDialogTitle>
          <AlertDialogDescription>
            Its sandbox is stopped and its shells close. Conversations stay in each agent&apos;s history.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isEnding}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={isEnding} onClick={onConfirm}>
            End session
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
