'use client';

import { useState } from 'react';
import { formatDistanceToNow, format } from 'date-fns';
import { Bot, ChevronDown, ChevronRight, FileEdit, History, MoreVertical, RotateCcw } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { RollbackToPointDialog, type RollbackToPointContext } from './RollbackToPointDialog';
import { ActivityItem, type RollbackContext } from './ActivityItem';
import { getInitials } from './utils';
import type { ActivityGroup, ActivityGroupType } from './types';
import type { ActivityActionResult } from '@/types/activity-actions';

interface ActivityGroupItemProps {
  group: ActivityGroup;
  context?: RollbackContext;
  onRollback?: (activityId: string, force: boolean) => Promise<ActivityActionResult>;
  onRollbackToPointSuccess?: () => void;
  defaultOpen?: boolean;
}

/**
 * Get the icon for a group type
 */
function getGroupIcon(type: ActivityGroupType) {
  switch (type) {
    case 'rollback':
      return History;
    case 'ai_stream':
      return Bot;
    case 'edit_session':
      return FileEdit;
  }
}

/**
 * Get the badge variant for a group type
 */
function getGroupBadgeVariant(type: ActivityGroupType): 'default' | 'secondary' | 'outline' {
  switch (type) {
    case 'rollback':
      return 'outline';
    case 'ai_stream':
      return 'secondary';
    case 'edit_session':
      return 'default';
  }
}

export function ActivityGroupItem({
  group,
  context,
  onRollback,
  onRollbackToPointSuccess,
  defaultOpen = false,
}: ActivityGroupItemProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [showRollbackToPoint, setShowRollbackToPoint] = useState(false);

  const { summary, activities, type } = group;
  const GroupIcon = getGroupIcon(type);
  const badgeVariant = getGroupBadgeVariant(type);

  // Get the oldest activity for group rollback (rollback-to-point)
  const oldestActivity = activities[activities.length - 1];

  // Can undo if context is available
  const canUndo = context && onRollback;

  return (
    <>
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        {/* Group Header */}
        <div className="flex items-center gap-2 sm:gap-4 py-4 border-b group">
          {/* Expand/Collapse button */}
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0">
              {isOpen ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
              <span className="sr-only">Toggle group</span>
            </Button>
          </CollapsibleTrigger>

          {/* Avatar */}
          <Avatar className="h-8 w-8 sm:h-10 sm:w-10 shrink-0">
            <AvatarImage src={summary.actorImage || undefined} alt={summary.actorName} />
            <AvatarFallback>
              {getInitials(summary.actorName, summary.actorName)}
            </AvatarFallback>
          </Avatar>

          {/* Content */}
          <div className="flex-1 min-w-0 space-y-1 overflow-hidden">
            <div className="flex flex-wrap items-center gap-1 sm:gap-2">
              <span className="font-medium text-sm truncate max-w-[100px] sm:max-w-none">{summary.actorName}</span>
              <Badge variant={badgeVariant} className="text-xs shrink-0">
                <GroupIcon className="h-3 w-3 mr-1" />
                {summary.label}
              </Badge>
            </div>

            <div className="text-xs text-muted-foreground">
              {activities.length} {activities.length === 1 ? 'activity' : 'activities'}
            </div>
          </div>

          {/* Timestamp and Actions */}
          <div className="flex items-start gap-1 sm:gap-2 shrink-0">
            <div className="text-xs text-muted-foreground shrink-0 text-right">
              <div className="hidden sm:block">{format(new Date(summary.timestamp), 'h:mm a')}</div>
              <div className="text-muted-foreground/60">
                {formatDistanceToNow(new Date(summary.timestamp), { addSuffix: true })}
              </div>
            </div>

            {canUndo && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
                  >
                    <MoreVertical className="h-4 w-4" />
                    <span className="sr-only">Actions</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => setShowRollbackToPoint(true)}>
                    <RotateCcw className="h-4 w-4 mr-2" />
                    Undo all {activities.length} changes
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>

        {/* Expanded Content - Individual Activities */}
        <CollapsibleContent>
          <div className="pl-4 sm:pl-10 border-l-2 border-muted ml-3 sm:ml-5">
            {activities.map((activity) => (
              <ActivityItem
                key={activity.id}
                activity={activity}
                context={context}
                onRollback={onRollback}
                onRollbackToPointSuccess={onRollbackToPointSuccess}
              />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Rollback to Point Dialog for group undo */}
      {context && (
        <RollbackToPointDialog
          open={showRollbackToPoint}
          onOpenChange={setShowRollbackToPoint}
          activityId={oldestActivity.id}
          context={context as RollbackToPointContext}
          onSuccess={onRollbackToPointSuccess}
        />
      )}
    </>
  );
}
