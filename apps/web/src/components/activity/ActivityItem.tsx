'use client';

import { useState } from 'react';
import { formatDistanceToNow, format } from 'date-fns';
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
import { RollbackConfirmDialog } from '@/components/version-history/RollbackConfirmDialog';
import { RollbackToPointDialog } from './RollbackToPointDialog';
import { useToast } from '@/hooks/useToast';
import { post } from '@/lib/auth/auth-fetch';
import { operationConfig, resourceTypeIcons, defaultOperationConfig } from './constants';
import { getInitials } from './utils';
import { getUserFacingModelName } from '@/lib/ai/core/ai-providers-config';
import type { ActivityLog } from './types';
import type { ActivityActionPreview, ActivityActionResult } from '@/types/activity-actions';

export type RollbackContext = 'page' | 'drive' | 'user_dashboard';

interface ActivityItemProps {
  activity: ActivityLog;
  context?: RollbackContext;
  onRollback?: (activityId: string, force: boolean) => Promise<ActivityActionResult>;
  onRollbackToPointSuccess?: () => void;
}

export function ActivityItem({ activity, context, onRollback, onRollbackToPointSuccess }: ActivityItemProps) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [showRollbackToPoint, setShowRollbackToPoint] = useState(false);
  const [preview, setPreview] = useState<ActivityActionPreview | null>(null);
  const { toast } = useToast();

  const displayOperation = activity.operation === 'rollback'
    ? activity.rollbackSourceOperation || activity.operation
    : activity.operation;
  const opConfig = operationConfig[activity.operation] || defaultOperationConfig;
  const dialogOperation = operationConfig[displayOperation]?.label || displayOperation;
  const OpIcon = opConfig.icon;
  const ResourceIcon = resourceTypeIcons[activity.resourceType] || FileText;

  const actorName = activity.user?.name || activity.actorDisplayName || activity.actorEmail;
  const actorImage = activity.user?.image;

  // All activities (including rollbacks) can be undone via the unified rollback endpoint
  const canUndo = context && onRollback;

  const handleActionClick = async () => {
    if (!context) return;

    try {
      // All undo operations go through /rollback - server handles rollback-of-rollback
      const data = await post<{ preview?: ActivityActionPreview }>(`/api/activities/${activity.id}/rollback`, { context, dryRun: true });
      setPreview(data.preview ?? null);
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to load rollback preview',
        variant: 'destructive',
      });
      setPreview({
        action: 'rollback',
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
            {opConfig.label}
          </Badge>
          {activity.isAiGenerated && (
            <Badge variant="outline" className="text-xs gap-1">
              <Bot className="h-3 w-3" />
              {getUserFacingModelName(activity.aiProvider, activity.aiModel)}
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
              <DropdownMenuItem onClick={() => handleActionClick()}>
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
      onConfirm={handleConfirm}
    />

    {context && (
      <RollbackToPointDialog
        open={showRollbackToPoint}
        onOpenChange={setShowRollbackToPoint}
        activityId={activity.id}
        context={context}
        onSuccess={onRollbackToPointSuccess}
      />
    )}
    </>
  );
}
