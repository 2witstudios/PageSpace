'use client';

import React, { useState, useEffect } from 'react';
import { Loader2, History, AlertTriangle, Wrench, Bot } from 'lucide-react';
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
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { fetchWithAuth, post } from '@/lib/auth/auth-fetch';
import { formatDistanceToNow } from 'date-fns';
import { createClientLogger } from '@/lib/logging/client-logger';
import type { RollbackToPointPreview } from '@/services/api';
import { getInitials } from './utils';

const logger = createClientLogger({ namespace: 'rollback', component: 'RollbackToPointDialog' });

export type RollbackToPointContext = 'page' | 'drive' | 'user_dashboard';

interface RollbackToPointDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activityId: string | null;
  context: RollbackToPointContext;
  onSuccess?: () => void;
}

export const RollbackToPointDialog: React.FC<RollbackToPointDialogProps> = ({
  open,
  onOpenChange,
  activityId,
  context,
  onSuccess,
}) => {
  const [preview, setPreview] = useState<RollbackToPointPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [force, setForce] = useState(false);

  // Fetch preview when dialog opens
  useEffect(() => {
    if (open && activityId) {
      logger.debug('[RollbackToPoint:Preview] Dialog opened, fetching preview', { activityId, context });
      setLoading(true);
      setError(null);
      setPreview(null);
      setForce(false);

      fetchWithAuth(`/api/activities/${activityId}/rollback-to-point?context=${context}`)
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
        .then((data: RollbackToPointPreview) => {
          logger.debug('[RollbackToPoint:Preview] Preview loaded', {
            activitiesCount: data.activitiesAffected.length,
            warningsCount: data.warnings.length,
          });
          setPreview(data);
        })
        .catch((err) => {
          logger.debug('[RollbackToPoint:Preview] Preview fetch failed', {
            error: err instanceof Error ? err.message : String(err),
          });
          setError(err instanceof Error ? err.message : 'Failed to load preview');
        })
        .finally(() => {
          setLoading(false);
        });
    }
  }, [open, activityId, context]);

  const handleConfirm = async () => {
    if (!activityId) return;

    logger.debug('[RollbackToPoint:Execute] User confirmed rollback', { activityId, context, force });
    setExecuting(true);
    setError(null);

    try {
      await post(`/api/activities/${activityId}/rollback-to-point`, { context, force });

      logger.debug('[RollbackToPoint:Execute] Rollback completed successfully');
      onOpenChange(false);
      onSuccess?.();
    } catch (err) {
      logger.debug('[RollbackToPoint:Execute] Rollback failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      setError(err instanceof Error ? err.message : 'Failed to rollback');
    } finally {
      setExecuting(false);
    }
  };

  const requiresForce = preview?.activitiesAffected.some((a) => a.preview.requiresForce) ?? false;
  const canRollbackCount =
    preview?.activitiesAffected.filter(
      (a) => a.preview.canExecute || (force && a.preview.requiresForce)
    ).length ?? 0;
  const conflictedActivities =
    preview?.activitiesAffected.filter((a) => a.preview.hasConflict) ?? [];
  const cannotRollbackActivities =
    preview?.activitiesAffected.filter(
      (a) => !a.preview.canExecute && !(force && a.preview.requiresForce)
    ) ?? [];

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <History className="h-5 w-5" />
            Rollback to this point
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
                  <div className="flex items-center gap-2 rounded-md border p-3">
                    <Wrench className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <div className="font-medium">{preview.activitiesAffected.length}</div>
                      <div className="text-xs text-muted-foreground">
                        changes will be undone
                      </div>
                    </div>
                  </div>

                  {/* Force option if needed */}
                  {requiresForce && (
                    <div className="flex items-center justify-between rounded-md border p-3">
                      <Label htmlFor="force-rollback" className="text-sm">
                        Force rollback (overwrite newer changes)
                      </Label>
                      <Switch
                        id="force-rollback"
                        checked={force}
                        onCheckedChange={setForce}
                      />
                    </div>
                  )}

                  {/* Cannot rollback warning */}
                  {cannotRollbackActivities.length > 0 && (
                    <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3">
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                        <div className="text-sm text-destructive">
                          <p className="font-medium mb-1">
                            {cannotRollbackActivities.length} change
                            {cannotRollbackActivities.length !== 1 ? 's' : ''} cannot be undone:
                          </p>
                          <div className="max-h-[120px] overflow-y-auto">
                            <ul className="list-disc list-inside space-y-0.5 text-xs pr-2">
                              {cannotRollbackActivities.map((activity) => (
                                <li key={activity.id}>
                                  {activity.operation} {activity.resourceTitle || activity.resourceType}
                                  {activity.preview.reason && `: ${activity.preview.reason}`}
                                </li>
                              ))}
                            </ul>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Conflicts warning */}
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
                                  {activity.resourceTitle || activity.resourceType}:{' '}
                                  {activity.preview.conflictFields.join(', ')}
                                </li>
                              ))}
                            </ul>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Activities list */}
                  {preview.activitiesAffected.length > 0 && (
                    <div className="border-t pt-3">
                      <p className="text-xs font-medium text-muted-foreground mb-2">
                        Changes to be undone (newest first):
                      </p>
                      <ScrollArea className="h-[200px]">
                        <div className="space-y-2 pr-4">
                          {preview.activitiesAffected.map((activity) => (
                            <div
                              key={activity.id}
                              className={`flex items-center gap-2 rounded-md border p-2 text-xs ${
                                !activity.preview.canExecute && !(force && activity.preview.requiresForce)
                                  ? 'opacity-50'
                                  : ''
                              }`}
                            >
                              {activity.isAiGenerated ? (
                                <div className="h-5 w-5 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                                  <Bot className="h-3 w-3 text-primary" />
                                </div>
                              ) : (
                                <Avatar className="h-5 w-5 shrink-0">
                                  <AvatarFallback className="text-[10px]">
                                    {getInitials(activity.actorDisplayName, activity.actorEmail || '??')}
                                  </AvatarFallback>
                                </Avatar>
                              )}
                              <div className="flex-1 min-w-0">
                                <div className="font-medium truncate">
                                  {activity.operation} {activity.resourceTitle || activity.resourceType}
                                </div>
                                <div className="text-muted-foreground">
                                  {formatDistanceToNow(new Date(activity.timestamp), { addSuffix: true })}
                                </div>
                              </div>
                              {!activity.preview.canExecute && (
                                <Badge variant="outline" className="text-[10px] shrink-0">
                                  {activity.preview.requiresForce ? 'Force required' : 'Cannot undo'}
                                </Badge>
                              )}
                            </div>
                          ))}
                        </div>
                      </ScrollArea>
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
            disabled={executing || loading || !preview || canRollbackCount === 0}
            className="gap-2"
          >
            {executing ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Rolling back...
              </>
            ) : (
              <>
                <History className="h-4 w-4" />
                Rollback {canRollbackCount} change{canRollbackCount !== 1 ? 's' : ''}
              </>
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
