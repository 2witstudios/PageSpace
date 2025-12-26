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

export type RollbackContext = 'page' | 'drive' | 'user_dashboard';

interface ActivityItemProps {
  activity: ActivityLog;
  context?: RollbackContext;
  onRollback?: (activityId: string, force?: boolean) => Promise<void>;
}

export function ActivityItem({ activity, context, onRollback }: ActivityItemProps) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [previewWarnings, setPreviewWarnings] = useState<string[]>([]);
  const [canRollback, setCanRollback] = useState(true);
  const [hasConflict, setHasConflict] = useState(false);
  const [rollbackReason, setRollbackReason] = useState<string | null>(null);
  const { toast } = useToast();
  const opConfig = operationConfig[activity.operation] || defaultOperationConfig;
  const OpIcon = opConfig.icon;
  const ResourceIcon = resourceTypeIcons[activity.resourceType] || FileText;

  const actorName = activity.user?.name || activity.actorDisplayName || activity.actorEmail;
  const actorImage = activity.user?.image;

  const canRestore = context && onRollback;

  const handleRestoreClick = async () => {
    if (!context) return;

    try {
      const response = await fetch(`/api/activities/${activity.id}?context=${context}`);
      if (!response.ok) {
        throw new Error('Failed to load preview');
      }
      const data = await response.json();
      setPreviewWarnings(data.warnings || []);
      setCanRollback(data.canRollback !== false);
      setHasConflict(data.hasConflict === true);
      setRollbackReason(data.reason || null);
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to load rollback preview',
        variant: 'destructive',
      });
      setPreviewWarnings([]);
      setCanRollback(false);
      setHasConflict(false);
      setRollbackReason('Failed to load rollback preview');
    }
    setShowConfirm(true);
  };

  const handleConfirmRollback = async (force?: boolean) => {
    if (onRollback) {
      await onRollback(activity.id, force);
    }
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

        {canRestore && (
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
              <DropdownMenuItem onClick={handleRestoreClick}>
                <History className="h-4 w-4 mr-2" />
                Restore this version
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
      operation={opConfig.label}
      timestamp={activity.timestamp}
      warnings={previewWarnings}
      onConfirm={handleConfirmRollback}
      canRollback={canRollback}
      hasConflict={hasConflict}
      reason={rollbackReason}
    />
    </>
  );
}
