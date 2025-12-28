'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, History, Loader2 } from 'lucide-react';
import { createClientLogger } from '@/lib/logging/client-logger';
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
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import type { ActivityActionPreview, ActivityActionResult } from '@/types/activity-actions';

const logger = createClientLogger({ namespace: 'rollback', component: 'RollbackConfirmDialog' });

interface RollbackConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resourceTitle: string | null;
  operation: string;
  timestamp: string;
  preview: ActivityActionPreview | null;
  onConfirm: (force: boolean) => Promise<ActivityActionResult>;
}

export function RollbackConfirmDialog({
  open,
  onOpenChange,
  resourceTitle,
  operation,
  timestamp,
  onConfirm,
  preview,
}: RollbackConfirmDialogProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [force, setForce] = useState(false);
  const [result, setResult] = useState<ActivityActionResult | null>(null);

  useEffect(() => {
    if (!open) {
      setIsLoading(false);
      setForce(false);
      setResult(null);
    }
  }, [open]);

  const handleConfirm = async () => {
    logger.debug('[Rollback:Dialog] User clicked confirm', {
      resourceTitle,
      operation,
      force,
    });

    setIsLoading(true);
    try {
      const actionResult = await onConfirm(force);
      setResult(actionResult);
      logger.debug('[Rollback:Dialog] Action completed', { status: actionResult.status });
    } catch (error) {
      logger.debug('[Rollback:Dialog] Rollback failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      setResult({
        action: 'rollback',
        status: 'failed',
        message: error instanceof Error ? error.message : 'Action failed',
        warnings: [],
        changesApplied: preview?.changes ?? [],
      });
    } finally {
      setIsLoading(false);
    }
  };

  const canProceed = !!preview
    && !preview.isNoOp
    && (preview.canExecute || (preview.requiresForce && force));

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <History className="h-5 w-5" />
            Undo change
          </AlertDialogTitle>
          <AlertDialogDescription className="space-y-3">
            <p>
              You are about to undo{' '}
              <Badge variant="secondary">{operation}</Badge> on{' '}
              <strong>{resourceTitle || 'this resource'}</strong> from{' '}
              {new Date(timestamp).toLocaleDateString()}.
            </p>
            <p className="text-xs text-muted-foreground">
              This only affects this specific change. Other updates stay as-is.
            </p>

            {!preview && (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )}

            {preview && !preview.canExecute && preview.reason && !preview.requiresForce && (
              <div className="rounded-md border border-red-200 bg-red-50 p-3 dark:border-red-800 dark:bg-red-900/20">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-500 mt-0.5" />
                  <div className="text-sm text-red-800 dark:text-red-200">
                    <p className="font-medium">Cannot undo</p>
                    <p className="mt-1">{preview.reason}</p>
                  </div>
                </div>
              </div>
            )}

            {preview && preview.warnings.length > 0 && (
              <div className="rounded-md border border-yellow-200 bg-yellow-50 p-3 dark:border-yellow-800 dark:bg-yellow-900/20">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-500 mt-0.5" />
                  <div className="text-sm text-yellow-800 dark:text-yellow-200">
                    <p className="font-medium">Warning</p>
                    <ul className="list-disc list-inside mt-1 space-y-1">
                      {preview.warnings.map((warning, idx) => (
                        <li key={idx}>{warning}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            )}

            {preview && preview.changes.length > 0 && (
              <div className="rounded-md border p-3">
                <p className="text-sm font-medium">Changes to apply</p>
                <div className="mt-2 space-y-2">
                  {preview.changes.map((change) => (
                    <div key={change.id} className="rounded-md bg-muted/50 p-2 text-xs">
                      <div className="font-medium">{change.label}</div>
                      {change.description && (
                        <div className="text-muted-foreground">{change.description}</div>
                      )}
                      {change.fields && change.fields.length > 0 && (
                        <div className="mt-1 text-muted-foreground">
                          Fields: {change.fields.join(', ')}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {preview && preview.hasConflict && preview.conflictFields.length > 0 && (
              <div className="rounded-md border border-yellow-200 bg-yellow-50 p-3 dark:border-yellow-800 dark:bg-yellow-900/20">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-500 mt-0.5" />
                  <div className="text-sm text-yellow-800 dark:text-yellow-200">
                    <p className="font-medium">Conflicts detected</p>
                    <p className="mt-1">
                      The current version has changed since this activity. Conflicting fields:
                    </p>
                    <p className="mt-1 text-xs">{preview.conflictFields.join(', ')}</p>
                  </div>
                </div>
              </div>
            )}

            {preview && preview.requiresForce && (
              <div className="flex items-center justify-between rounded-md border p-3">
                <Label htmlFor="force-restore" className="text-sm">
                  Force undo (overwrite newer changes)
                </Label>
                <Switch
                  id="force-restore"
                  checked={force}
                  onCheckedChange={setForce}
                />
              </div>
            )}

            {result && (
              <div className="rounded-md border p-3 text-sm">
                <p className="font-medium">
                  {result.status === 'success'
                    ? 'Action completed'
                    : result.status === 'no_op'
                    ? 'No changes needed'
                    : 'Action failed'}
                </p>
                <p className="mt-1 text-muted-foreground">{result.message}</p>
              </div>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isLoading}>
            {result ? 'Close' : 'Cancel'}
          </AlertDialogCancel>
          {!result && (
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleConfirm();
              }}
              disabled={isLoading || !canProceed}
              className="gap-2"
            >
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Undoing...
                </>
              ) : (
                <>
                  <History className="h-4 w-4" />
                  Undo
                </>
              )}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
