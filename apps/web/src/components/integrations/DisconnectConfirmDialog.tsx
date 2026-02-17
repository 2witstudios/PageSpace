'use client';

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

interface DisconnectConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionName: string;
  onConfirm: () => void;
}

export function DisconnectConfirmDialog({
  open,
  onOpenChange,
  connectionName,
  onConfirm,
}: DisconnectConfirmDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect {connectionName}?</AlertDialogTitle>
          <AlertDialogDescription>
            This will remove the connection and revoke access. Any AI agents using this
            integration will lose access to its tools. This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Disconnect
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
