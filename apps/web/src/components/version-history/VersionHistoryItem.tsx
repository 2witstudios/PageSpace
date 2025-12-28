'use client';

import { useState } from 'react';
import { formatDistanceToNow, format } from 'date-fns';
import { createClientLogger } from '@/lib/logging/client-logger';
import { Bot, FileText, History, MoreVertical, RotateCcw } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { operationConfig, resourceTypeIcons, defaultOperationConfig } from '@/components/activity/constants';
import { getInitials } from '@/components/activity/utils';
import { RollbackConfirmDialog } from './RollbackConfirmDialog';
import { RollbackToPointDialog, type RollbackToPointContext } from '@/components/activity/RollbackToPointDialog';
import { useToast } from '@/hooks/useToast';
import { post } from '@/lib/auth/auth-fetch';
import type { ActivityLog } from '@/components/activity/types';
import type { ActivityAction, ActivityActionPreview, ActivityActionResult } from '@/types/activity-actions';

const logger = createClientLogger({ namespace: 'rollback', component: 'VersionHistoryItem' });

interface VersionHistoryItemProps {
  activity: ActivityLog & { canRollback?: boolean };
  context: 'page' | 'drive' | 'ai_tool' | 'user_dashboard';
  onRollback?: (activityId: string, force: boolean) => Promise<ActivityActionResult>;
  onRedo?: (activityId: string, force: boolean) => Promise<ActivityActionResult>;
  onRollbackToPointSuccess?: () => void;
}

export function VersionHistoryItem({
  activity,
  context,
  onRollback,
  onRedo,
  onRollbackToPointSuccess,
}: VersionHistoryItemProps) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [showRollbackToPoint, setShowRollbackToPoint] = useState(false);
  const [preview, setPreview] = useState<ActivityActionPreview | null>(null);
  const [action, setAction] = useState<ActivityAction>('rollback');
  const { toast } = useToast();

  const metadata = activity.metadata as { redoFromActivityId?: string } | null;
  const isRedoEntry = activity.operation === 'rollback' && !!metadata?.redoFromActivityId;
  const displayOperation = activity.operation === 'rollback'
    ? activity.rollbackSourceOperation || activity.operation
    : activity.operation;
  const opConfig = operationConfig[activity.operation] || defaultOperationConfig;
  const dialogOperation = operationConfig[displayOperation]?.label || displayOperation;
  const OpIcon = opConfig.icon;
  const ResourceIcon = resourceTypeIcons[activity.resourceType] || FileText;

  const actorName = activity.user?.name || activity.actorDisplayName || activity.actorEmail;
  const actorImage = activity.user?.image;

  const handleActionClick = async (nextAction: ActivityAction) => {
    logger.debug('[Rollback:Preview] User clicked restore version', {
      activityId: activity.id,
      operation: activity.operation,
      resourceType: activity.resourceType,
      context,
    });

    setAction(nextAction);

    // Fetch preview using dry run to get warnings and conflict status
    try {
      const endpoint = nextAction === 'redo'
        ? `/api/activities/${activity.id}/redo`
        : `/api/activities/${activity.id}/rollback`;
      const data = await post<{ preview?: ActivityActionPreview }>(endpoint, { context, dryRun: true });
      logger.debug('[Rollback:Preview] Preview loaded', {
        activityId: activity.id,
        warningsCount: data.preview?.warnings?.length || 0,
        hasConflict: data.preview?.hasConflict || false,
        canExecute: data.preview?.canExecute,
      });
      setPreview(data.preview ?? null);
    } catch (error) {
      logger.debug('[Rollback:Preview] Preview error', {
        activityId: activity.id,
        error: error instanceof Error ? error.message : String(error),
      });
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to load rollback preview',
        variant: 'destructive',
      });
      setPreview({
        action: nextAction,
        canExecute: false,
        reason: 'Preview unavailable. Please try again.',
        warnings: [],
        hasConflict: false,
        conflictFields: [],
        requiresForce: false,
        isNoOp: false,
        currentValues: null,
        targetValues: null,
        changes: [],
        affectedResources: [],
      });
    }
    setShowConfirm(true);
  };

  const handleConfirm = async (force: boolean) => {
    logger.debug('[Rollback:Execute] User confirmed rollback via dialog', {
      activityId: activity.id,
      force,
      action,
    });
    if (action === 'redo') {
      if (!onRedo) {
        throw new Error('Redo is not available');
      }
      return onRedo(activity.id, force);
    }
    if (!onRollback) {
      throw new Error('Rollback is not available');
    }
    return onRollback(activity.id, force);
  };

  const isRollbackActivity = activity.operation === 'rollback';
  // For rollback activities, "Undo" means revert the rollback (redo)
  // For other activities, "Undo" means rollback
  const canUndo = activity.canRollback !== false && (isRollbackActivity ? onRedo : onRollback);

  return (
    <>
      <div className="flex items-start gap-4 py-4 border-b last:border-b-0 group">
        {/* Avatar */}
        <Avatar className="h-10 w-10 shrink-0">
          <AvatarImage src={actorImage || undefined} alt={actorName} />
          <AvatarFallback>{getInitials(activity.actorDisplayName, activity.actorEmail)}</AvatarFallback>
        </Avatar>

        {/* Content */}
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-sm">{actorName}</span>
            <Badge variant={opConfig.variant} className="text-xs">
              <OpIcon className="h-3 w-3 mr-1" />
              {isRedoEntry ? 'Revert rollback' : opConfig.label}
            </Badge>
            {activity.isAiGenerated && (
              <Badge variant="outline" className="text-xs gap-1">
                <Bot className="h-3 w-3" />
                AI
                {activity.aiModel && <span className="text-muted-foreground">({activity.aiModel})</span>}
              </Badge>
            )}
          </div>

          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <ResourceIcon className="h-4 w-4 shrink-0" />
            <span className="truncate">
              {activity.resourceTitle || activity.resourceType}
            </span>
          </div>

          {/* Updated fields */}
          {activity.updatedFields && activity.updatedFields.length > 0 && (
            <div className="text-xs text-muted-foreground">
              Changed: {activity.updatedFields.join(', ')}
            </div>
          )}
        </div>

        {/* Timestamp and Actions */}
        <div className="flex items-start gap-2">
          <div className="text-xs text-muted-foreground shrink-0 text-right">
            <div>{format(new Date(activity.timestamp), 'h:mm a')}</div>
            <div className="text-muted-foreground/60">
              {formatDistanceToNow(new Date(activity.timestamp), { addSuffix: true })}
            </div>
          </div>

          {canUndo && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <MoreVertical className="h-4 w-4" />
                  <span className="sr-only">Actions</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => handleActionClick(isRollbackActivity ? 'redo' : 'rollback')}>
                  <History className="h-4 w-4 mr-2" />
                  Undo this change
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setShowRollbackToPoint(true)}>
                  <RotateCcw className="h-4 w-4 mr-2" />
                  Rollback to this point
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      <RollbackConfirmDialog
        open={showConfirm}
        onOpenChange={setShowConfirm}
        resourceTitle={activity.resourceTitle}
        operation={dialogOperation}
        timestamp={activity.timestamp}
        preview={preview}
        action={action}
        onConfirm={handleConfirm}
      />

      <RollbackToPointDialog
        open={showRollbackToPoint}
        onOpenChange={setShowRollbackToPoint}
        activityId={activity.id}
        context={context === 'ai_tool' ? 'page' : context as RollbackToPointContext}
        onSuccess={onRollbackToPointSuccess}
      />
    </>
  );
}
