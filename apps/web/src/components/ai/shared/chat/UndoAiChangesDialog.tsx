'use client';

import React, { useState, useEffect } from 'react';
import { Loader2, Undo2, AlertTriangle, MessageSquare, Wrench } from 'lucide-react';
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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { fetchWithAuth, post } from '@/lib/auth/auth-fetch';
import type { AiUndoPreview, UndoMode } from '@/services/api';
import { createClientLogger } from '@/lib/logging/client-logger';

const logger = createClientLogger({ namespace: 'rollback', component: 'UndoAiChangesDialog' });

interface UndoAiChangesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messageId: string | null;
  onSuccess?: () => void;
}

export const UndoAiChangesDialog: React.FC<UndoAiChangesDialogProps> = ({
  open,
  onOpenChange,
  messageId,
  onSuccess,
}) => {
  const [preview, setPreview] = useState<AiUndoPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<UndoMode>('messages_only');
  const [force, setForce] = useState(false);

  // Fetch preview when dialog opens
  useEffect(() => {
    if (open && messageId) {
      logger.debug('[AiUndo:Preview] Dialog opened, fetching preview', { messageId });
      setLoading(true);
      setError(null);
      setPreview(null);
      setMode('messages_only');
      setForce(false);

      fetchWithAuth(`/api/ai/chat/messages/${messageId}/undo`)
        .then(async (res) => {
          if (!res.ok) {
            let errorMessage = 'Failed to load preview';
            try {
              const data = await res.json();
              errorMessage = data.error || errorMessage;
            } catch {
              // Response wasn't JSON, use default message
            }
            throw new Error(errorMessage);
          }
          return res.json();
        })
        .then((data: AiUndoPreview) => {
          logger.debug('[AiUndo:Preview] Preview loaded', {
            messagesAffected: data.messagesAffected,
            activitiesCount: data.activitiesAffected.length,
            warningsCount: data.warnings.length,
          });
          setPreview(data);
        })
        .catch((err) => {
          logger.debug('[AiUndo:Preview] Preview fetch failed', {
            error: err instanceof Error ? err.message : String(err),
          });
          setError(err instanceof Error ? err.message : 'Failed to load preview');
        })
        .finally(() => {
          setLoading(false);
        });
    }
  }, [open, messageId]);

  const handleConfirm = async () => {
    if (!messageId) return;

    logger.debug('[AiUndo:Execute] User confirmed undo', { messageId, mode });
    setExecuting(true);
    setError(null);

    try {
      // post() returns parsed JSON and throws on errors
      await post(`/api/ai/chat/messages/${messageId}/undo`, { mode, force });

      logger.debug('[AiUndo:Execute] Undo completed successfully', { mode });
      onOpenChange(false);
      onSuccess?.();
    } catch (err) {
      logger.debug('[AiUndo:Execute] Undo failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      // post() extracts error messages from json.error or json.message
      setError(err instanceof Error ? err.message : 'Failed to undo changes');
    } finally {
      setExecuting(false);
    }
  };

  const requiresForce = preview?.activitiesAffected.some(a => a.preview.requiresForce) ?? false;
  const canRollbackCount = preview?.activitiesAffected.filter(a => a.preview.canExecute || (force && a.preview.requiresForce)).length ?? 0;
  const conflictedActivities = preview?.activitiesAffected.filter(a => a.preview.hasConflict) ?? [];

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Undo2 className="h-5 w-5" />
            Undo from here
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-4">
              {loading && (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              )}

              {error && !loading && (
                <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                  {error}
                </div>
              )}

              {preview && !loading && (
                <>
                  {/* Summary */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex items-center gap-2 rounded-md border p-3">
                      <MessageSquare className="h-4 w-4 text-muted-foreground" />
                      <div>
                        <div className="font-medium">{preview.messagesAffected}</div>
                        <div className="text-xs text-muted-foreground">messages</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 rounded-md border p-3">
                      <Wrench className="h-4 w-4 text-muted-foreground" />
                      <div>
                        <div className="font-medium">{canRollbackCount}</div>
                        <div className="text-xs text-muted-foreground">changes to undo</div>
                      </div>
                    </div>
                  </div>

                  {/* Mode Selection */}
                  <RadioGroup value={mode} onValueChange={(v) => setMode(v as UndoMode)}>
                    <div className="flex items-start space-x-3 rounded-md border p-3">
                      <RadioGroupItem value="messages_only" id="messages_only" className="mt-1" />
                      <Label htmlFor="messages_only" className="flex-1 cursor-pointer">
                        <div className="font-medium">Revert conversation only</div>
                        <div className="text-xs text-muted-foreground">
                          Delete {preview.messagesAffected} message{preview.messagesAffected !== 1 ? 's' : ''} from this point forward
                        </div>
                      </Label>
                    </div>

                    <div className="flex items-start space-x-3 rounded-md border p-3">
                      <RadioGroupItem
                        value="messages_and_changes"
                        id="messages_and_changes"
                        className="mt-1"
                        disabled={canRollbackCount === 0}
                      />
                      <Label
                        htmlFor="messages_and_changes"
                        className={`flex-1 ${canRollbackCount === 0 ? 'opacity-50' : 'cursor-pointer'}`}
                      >
                        <div className="font-medium">Revert conversation + all changes</div>
                        <div className="text-xs text-muted-foreground">
                          Delete messages and undo {canRollbackCount} tool change{canRollbackCount !== 1 ? 's' : ''}
                        </div>
                      </Label>
                    </div>
                  </RadioGroup>

                  {requiresForce && (
                    <div className="flex items-center justify-between rounded-md border p-3">
                      <Label htmlFor="force-undo" className="text-sm">
                        Force undo (overwrite newer changes)
                      </Label>
                      <Switch
                        id="force-undo"
                        checked={force}
                        onCheckedChange={setForce}
                      />
                    </div>
                  )}

                  {/* Warnings */}
                  {preview.warnings.length > 0 && (
                    <div className="rounded-md border border-yellow-200 bg-yellow-50 p-3 dark:border-yellow-800 dark:bg-yellow-900/20">
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-500 mt-0.5 shrink-0" />
                        <div className="text-sm text-yellow-800 dark:text-yellow-200">
                          <p className="font-medium mb-1">Some changes cannot be undone:</p>
                          <div className="max-h-[120px] overflow-y-auto">
                            <ul className="list-disc list-inside space-y-0.5 text-xs pr-2">
                              {preview.warnings.map((warning, idx) => (
                                <li key={idx}>{warning}</li>
                              ))}
                            </ul>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {conflictedActivities.length > 0 && (
                    <div className="rounded-md border border-yellow-200 bg-yellow-50 p-3 dark:border-yellow-800 dark:bg-yellow-900/20">
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-500 mt-0.5 shrink-0" />
                        <div className="text-sm text-yellow-800 dark:text-yellow-200">
                          <p className="font-medium mb-1">Conflicts detected</p>
                          <div className="max-h-[120px] overflow-y-auto">
                            <ul className="list-disc list-inside space-y-0.5 text-xs pr-2">
                              {conflictedActivities.map((activity) => (
                                <li key={activity.id}>
                                  {activity.resourceTitle || activity.resourceType}: {activity.preview.conflictFields.join(', ')}
                                </li>
                              ))}
                            </ul>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Activities list (collapsed) */}
                  {mode === 'messages_and_changes' && canRollbackCount > 0 && (
                    <div className="text-xs text-muted-foreground border-t pt-3">
                      <p className="font-medium mb-1">Changes to be undone:</p>
                      <div className="max-h-[100px] overflow-y-auto">
                        <div className="flex flex-wrap gap-1 pr-2">
                          {preview.activitiesAffected
                            .filter(a => a.preview.canExecute || (force && a.preview.requiresForce))
                            .map((activity) => (
                              <Badge key={activity.id} variant="secondary" className="text-xs">
                                {activity.preview.changes[0]?.label || `${activity.operation} ${activity.resourceTitle || activity.resourceType}`}
                              </Badge>
                            ))}
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={executing}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              handleConfirm();
            }}
            disabled={executing || loading || !preview || (mode === 'messages_and_changes' && canRollbackCount === 0)}
            className="gap-2"
          >
            {executing ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Undoing...
              </>
            ) : (
              <>
                <Undo2 className="h-4 w-4" />
                Undo
              </>
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
