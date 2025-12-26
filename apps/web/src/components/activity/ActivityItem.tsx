'use client';

import { useState } from 'react';
import { formatDistanceToNow, format } from 'date-fns';
import { Bot, FileText, History, MoreVertical } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { RollbackConfirmDialog } from '@/components/version-history/RollbackConfirmDialog';
import { useToast } from '@/hooks/useToast';
import { operationConfig, resourceTypeIcons, defaultOperationConfig } from './constants';
import { getInitials } from './utils';
import type { ActivityLog } from './types';
import type { ActivityAction, ActivityActionPreview, ActivityActionResult } from '@/types/activity-actions';

export type RollbackContext = 'page' | 'drive' | 'user_dashboard';

interface ActivityItemProps {
  activity: ActivityLog;
  context?: RollbackContext;
  onRollback?: (activityId: string, force: boolean) => Promise<ActivityActionResult>;
  onRedo?: (activityId: string, force: boolean) => Promise<ActivityActionResult>;
}

export function ActivityItem({ activity, context, onRollback, onRedo }: ActivityItemProps) {
  const [showConfirm, setShowConfirm] = useState(false);
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

  const canRestore = context && onRollback;
  const canRedo = context && onRedo && activity.operation === 'rollback';

  const handleActionClick = async (nextAction: ActivityAction) => {
    if (!context) return;

    setAction(nextAction);
    try {
      const endpoint = nextAction === 'redo'
        ? `/api/activities/${activity.id}/redo`
        : `/api/activities/${activity.id}/rollback`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context, dryRun: true }),
      });
      if (!response.ok) {
        throw new Error('Failed to load preview');
      }
      const data = await response.json();
      setPreview(data.preview ?? null);
    } catch (error) {
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
            {isRedoEntry ? 'Redo rollback' : opConfig.label}
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

        {(canRestore || canRedo) && (
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
              {canRestore && (
                <DropdownMenuItem onClick={() => handleActionClick('rollback')}>
                  <History className="h-4 w-4 mr-2" />
                  Undo this change
                </DropdownMenuItem>
              )}
              {canRedo && (
                <DropdownMenuItem onClick={() => handleActionClick('redo')}>
                  <History className="h-4 w-4 mr-2" />
                  Redo rollback
                </DropdownMenuItem>
              )}
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
    </>
  );
}
