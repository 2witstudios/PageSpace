'use client';

import { useState } from 'react';
import { AlertTriangle, History, Loader2 } from 'lucide-react';
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
import { Badge } from '@/components/ui/badge';

interface RollbackConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activityId: string;
  resourceTitle: string | null;
  operation: string;
  timestamp: string;
  warnings: string[];
  onConfirm: () => Promise<void>;
}

export function RollbackConfirmDialog({
  open,
  onOpenChange,
  activityId,
  resourceTitle,
  operation,
  timestamp,
  warnings,
  onConfirm,
}: RollbackConfirmDialogProps) {
  const [isLoading, setIsLoading] = useState(false);

  const handleConfirm = async () => {
    setIsLoading(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (error) {
      console.error('Rollback failed:', error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <History className="h-5 w-5" />
            Restore Previous Version
          </AlertDialogTitle>
          <AlertDialogDescription className="space-y-3">
            <p>
              You are about to restore{' '}
              <strong>{resourceTitle || 'this resource'}</strong> to the state
              before the <Badge variant="secondary">{operation}</Badge> operation
              on {new Date(timestamp).toLocaleDateString()}.
            </p>

            {warnings.length > 0 && (
              <div className="rounded-md border border-yellow-200 bg-yellow-50 p-3 dark:border-yellow-800 dark:bg-yellow-900/20">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-500 mt-0.5" />
                  <div className="text-sm text-yellow-800 dark:text-yellow-200">
                    <p className="font-medium">Warning</p>
                    <ul className="list-disc list-inside mt-1 space-y-1">
                      {warnings.map((warning, idx) => (
                        <li key={idx}>{warning}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            )}

            <p className="text-sm text-muted-foreground">
              This action will create a new version in the history. You can always
              restore to any previous version later.
            </p>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isLoading}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={isLoading}
            className="gap-2"
          >
            {isLoading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Restoring...
              </>
            ) : (
              <>
                <History className="h-4 w-4" />
                Restore Version
              </>
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
