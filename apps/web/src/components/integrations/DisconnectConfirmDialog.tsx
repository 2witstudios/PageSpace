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
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertTriangle } from 'lucide-react';
import { useConnectionGrantCount } from '@/hooks/useIntegrations';
import type { SafeConnection } from '@/components/integrations/types';

interface DisconnectConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionName: string;
  onConfirm: () => void;
  affectedAgentCount?: number;
}

export function DisconnectConfirmDialog({
  open,
  onOpenChange,
  connectionName,
  onConfirm,
  affectedAgentCount,
}: DisconnectConfirmDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect {connectionName}?</AlertDialogTitle>
          <AlertDialogDescription>
            This will remove the connection and revoke access. This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {affectedAgentCount !== undefined && affectedAgentCount > 0 && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              {affectedAgentCount === 1
                ? '1 AI agent is using this integration and will lose access to its tools.'
                : `${affectedAgentCount} AI agents are using this integration and will lose access to its tools.`}
            </AlertDescription>
          </Alert>
        )}
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

export function DisconnectWithAgentCount({
  connection,
  onOpenChange,
  onConfirm,
}: {
  connection: SafeConnection | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const { count } = useConnectionGrantCount(connection?.id ?? null);

  return (
    <DisconnectConfirmDialog
      open={!!connection}
      onOpenChange={onOpenChange}
      connectionName={connection?.name ?? ''}
      onConfirm={onConfirm}
      affectedAgentCount={count}
    />
  );
}
