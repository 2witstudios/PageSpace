"use client";

import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { useParams, usePathname } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Activity,
  Search,
  FileEdit,
  Trash2,
  RotateCcw,
  Move,
  Share2,
  Bot,
  FolderPlus,
  Settings,
  History,
  MoreVertical,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { fetchWithAuth, post } from '@/lib/auth/auth-fetch';
import { RollbackConfirmDialog } from '@/components/version-history/RollbackConfirmDialog';
import { useToast } from '@/hooks/useToast';
import type { ActivityAction, ActivityActionPreview, ActivityActionResult } from '@/types/activity-actions';

// Exported for unit testing
export interface ActivityUser {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
}

// Exported for unit testing
export interface ActivityItem {
  id: string;
  timestamp: string;
  operation: string;
  resourceType: string;
  resourceId: string;
  resourceTitle: string | null;
  isAiGenerated: boolean;
  aiProvider: string | null;
  aiModel: string | null;
  metadata: Record<string, unknown> | null;
  rollbackSourceOperation: string | null;
  // User relation - null when user has been deleted (FK set null)
  user: ActivityUser | null;
  // Denormalized actor info - preserved for audit trail when user is deleted
  actorEmail: string | null;
  actorDisplayName: string | null;
}

/**
 * Get display name for an activity actor.
 * Prioritizes user relation, falls back to denormalized actor info.
 * Exported for unit testing.
 */
export function getActorDisplayName(activity: ActivityItem): string {
  // Prefer user relation if available
  if (activity.user?.name) {
    return activity.user.name;
  }
  // Fall back to denormalized actor display name
  if (activity.actorDisplayName) {
    return activity.actorDisplayName;
  }
  // Fall back to actor email
  if (activity.actorEmail) {
    return activity.actorEmail;
  }
  // Ultimate fallback
  return 'Unknown';
}

/**
 * Get avatar info for an activity actor.
 */
function getActorAvatar(activity: ActivityItem): { image: string | null; initial: string } {
  if (activity.user) {
    return {
      image: activity.user.image,
      initial: activity.user.name?.[0]?.toUpperCase() || '?',
    };
  }
  // Deleted user - use first character of display name or email
  const displayName = activity.actorDisplayName || activity.actorEmail;
  return {
    image: null,
    initial: displayName?.[0]?.toUpperCase() || '?',
  };
}

interface ActivityResponse {
  activities: ActivityItem[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

// Operation icons mapping
const operationIcons: Record<string, React.ReactNode> = {
  create: <FolderPlus className="h-3 w-3" />,
  update: <FileEdit className="h-3 w-3" />,
  delete: <Trash2 className="h-3 w-3" />,
  trash: <Trash2 className="h-3 w-3" />,
  restore: <RotateCcw className="h-3 w-3" />,
  reorder: <Move className="h-3 w-3" />,
  move: <Move className="h-3 w-3" />,
  permission_grant: <Share2 className="h-3 w-3" />,
  permission_update: <Share2 className="h-3 w-3" />,
  permission_revoke: <Share2 className="h-3 w-3" />,
  agent_config_update: <Settings className="h-3 w-3" />,
  rollback: <History className="h-3 w-3" />,
};

// Human-readable operation labels
const operationLabels: Record<string, string> = {
  create: 'Created',
  update: 'Updated',
  delete: 'Deleted',
  trash: 'Trashed',
  restore: 'Restored',
  reorder: 'Reordered',
  move: 'Moved',
  permission_grant: 'Shared',
  permission_update: 'Updated sharing',
  permission_revoke: 'Revoked access',
  agent_config_update: 'Configured agent',
  rollback: 'Rolled back',
};

/**
 * Activity tab for the right sidebar.
 *
 * Shows activity based on context:
 * - Dashboard (/dashboard): User's own activity
 * - Drive view (/dashboard/[driveId]): All drive activity
 * - Page view (/dashboard/[driveId]/[pageId]): All page activity
 */
export default function SidebarActivityTab() {
  const params = useParams();
  const pathname = usePathname();
  const { toast } = useToast();

  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Rollback state
  const [selectedActivityForRollback, setSelectedActivityForRollback] = useState<ActivityItem | null>(null);
  const [showRollbackConfirm, setShowRollbackConfirm] = useState(false);
  const [preview, setPreview] = useState<ActivityActionPreview | null>(null);
  const [action, setAction] = useState<ActivityAction>('rollback');

  // Determine context and IDs from route params
  const driveId = params.driveId as string | undefined;
  const pageId = params.pageId as string | undefined;

  // Determine the activity context
  const context = useMemo(() => {
    if (pageId) return 'page';
    if (driveId) return 'drive';
    return 'user'; // Dashboard view
  }, [driveId, pageId]);

  // Map to rollback API context
  const rollbackContext = useMemo(() => {
    if (pageId) return 'page';
    if (driveId) return 'drive';
    return 'user_dashboard';
  }, [driveId, pageId]);

  // Context-aware header text
  const headerText = useMemo(() => {
    switch (context) {
      case 'page':
        return 'Page Activity';
      case 'drive':
        return 'Drive Activity';
      default:
        return 'Your Activity';
    }
  }, [context]);

  const getOperationLabel = useCallback((activity: ActivityItem) => {
    const metadata = activity.metadata;
    const redoFromActivityId = typeof metadata === 'object' && metadata !== null
      ? (metadata as { redoFromActivityId?: string }).redoFromActivityId
      : undefined;

    if (activity.operation === 'rollback' && redoFromActivityId) {
      return 'Redo rollback';
    }
    return operationLabels[activity.operation] || activity.operation;
  }, []);

  // Load activities
  const loadActivities = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const queryParams = new URLSearchParams({ context });
      if (driveId) queryParams.set('driveId', driveId);
      if (pageId) queryParams.set('pageId', pageId);

      const response = await fetchWithAuth(`/api/activities?${queryParams}`);

      if (response.ok) {
        const data: ActivityResponse = await response.json();
        setActivities(data.activities);
      } else {
        const errorData = await response.json().catch(() => ({}));
        setError(errorData.error || 'Failed to load activity');
        setActivities([]);
      }
    } catch (err) {
      console.error('Failed to load activities:', err);
      setError('Failed to load activity');
      setActivities([]);
    } finally {
      setLoading(false);
    }
  }, [context, driveId, pageId]);

  useEffect(() => {
    loadActivities();
  }, [loadActivities, pathname]);

  // Handle restore click - fetch preview and show confirm dialog
  const handleActionClick = useCallback(async (activity: ActivityItem, nextAction: ActivityAction) => {
    setSelectedActivityForRollback(activity);
    setAction(nextAction);

    try {
      const endpoint = nextAction === 'redo'
        ? `/api/activities/${activity.id}/redo`
        : `/api/activities/${activity.id}/rollback`;
      const data = await post<{ preview: ActivityActionPreview | null }>(endpoint, {
        context: rollbackContext,
        dryRun: true,
      });
      setPreview(data.preview ?? null);
    } catch (err) {
      toast({
        title: 'Error',
        description: err instanceof Error ? err.message : 'Failed to load rollback preview',
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
    setShowRollbackConfirm(true);
  }, [rollbackContext, toast]);

  // Handle confirmed rollback
  const handleConfirmAction = useCallback(async (force: boolean): Promise<ActivityActionResult> => {
    if (!selectedActivityForRollback) {
      throw new Error('No activity selected');
    }

    try {
      const endpoint = action === 'redo'
        ? `/api/activities/${selectedActivityForRollback.id}/redo`
        : `/api/activities/${selectedActivityForRollback.id}/rollback`;
      const result = await post<ActivityActionResult>(endpoint, {
        context: rollbackContext,
        force,
      });

      toast({
        title: 'Success',
        description: result.message || 'Action completed',
      });

      // Refresh the activity list
      loadActivities();

      return result;
    } catch (err) {
      toast({
        title: 'Error',
        description: err instanceof Error ? err.message : 'Failed to rollback',
        variant: 'destructive',
      });
      throw err;
    }
  }, [selectedActivityForRollback, rollbackContext, toast, loadActivities, action]);

  // Filter activities based on search query
  const filteredActivities = useMemo(() => {
    if (!searchQuery.trim()) return activities;
    const query = searchQuery.toLowerCase();
    return activities.filter(
      (a) =>
        a.resourceTitle?.toLowerCase().includes(query) ||
        getActorDisplayName(a).toLowerCase().includes(query) ||
        operationLabels[a.operation]?.toLowerCase().includes(query)
    );
  }, [activities, searchQuery]);

  // Loading state
  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <div className="p-3 border-b border-[var(--separator)] space-y-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-8 w-full" />
        </div>
        <div className="flex-grow p-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="py-2 px-2 space-y-1">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-3 border-b border-[var(--separator)] space-y-2">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-medium">{headerText}</h3>
        </div>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search activity..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-8 h-8 text-xs"
          />
        </div>
      </div>

      {/* Activity List */}
      <div className="flex-grow overflow-y-auto">
        {error ? (
          <div className="text-center py-8 px-4">
            <Activity className="h-8 w-8 mx-auto text-muted-foreground mb-2 opacity-50" />
            <p className="text-sm text-muted-foreground">{error}</p>
          </div>
        ) : filteredActivities.length === 0 ? (
          <div className="text-center py-8 px-4">
            <Activity className="h-8 w-8 mx-auto text-muted-foreground mb-2 opacity-50" />
            <p className="text-sm text-muted-foreground">
              {searchQuery ? 'No matching activity' : 'No activity yet'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-[var(--separator)]">
            {filteredActivities.map((activity) => (
              <div
                key={activity.id}
                className="py-2.5 px-3 hover:bg-accent/30 transition-colors group"
              >
                <div className="flex items-start gap-2">
                  {/* User avatar or AI indicator */}
                  {activity.isAiGenerated ? (
                    <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                      <Bot className="h-3 w-3 text-primary" />
                    </div>
                  ) : (
                    <Avatar className="h-6 w-6 flex-shrink-0">
                      <AvatarImage src={getActorAvatar(activity).image || undefined} />
                      <AvatarFallback className="text-xs bg-muted">
                        {getActorAvatar(activity).initial}
                      </AvatarFallback>
                    </Avatar>
                  )}

                  <div className="flex-1 min-w-0">
                    {/* Actor and action */}
                    <div className="flex items-center gap-1 text-sm">
                      <span className="font-medium truncate">
                        {activity.isAiGenerated
                          ? `${getActorDisplayName(activity)} (via AI)`
                          : getActorDisplayName(activity)}
                      </span>
                    </div>

                    {/* Operation and resource */}
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-0.5">
                      {operationIcons[activity.operation] || (
                        <Activity className="h-3 w-3" />
                      )}
                      <span>
                        {getOperationLabel(activity)}
                      </span>
                      {activity.resourceTitle && (
                        <>
                          <span className="text-muted-foreground/60">-</span>
                          <span className="truncate max-w-[120px]">
                            {activity.resourceTitle}
                          </span>
                        </>
                      )}
                    </div>

                    {/* Timestamp and AI model */}
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-muted-foreground/70">
                        {formatDistanceToNow(new Date(activity.timestamp), {
                          addSuffix: true,
                        })}
                      </span>
                      {activity.isAiGenerated && activity.aiModel && (
                        <Badge
                          variant="secondary"
                          className="text-[10px] h-4 px-1.5 py-0"
                        >
                          {activity.aiModel}
                        </Badge>
                      )}
                    </div>
                  </div>

                  {/* Rollback action */}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                      >
                        <MoreVertical className="h-3 w-3" />
                        <span className="sr-only">Actions</span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => handleActionClick(activity, 'rollback')}>
                        <History className="h-4 w-4 mr-2" />
                        Undo this change
                      </DropdownMenuItem>
                      {activity.operation === 'rollback' && (
                        <DropdownMenuItem onClick={() => handleActionClick(activity, 'redo')}>
                          <History className="h-4 w-4 mr-2" />
                          Redo rollback
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-[var(--separator)] p-3">
        <div className="text-xs text-muted-foreground text-center">
          {activities.length} {activities.length === 1 ? 'event' : 'events'}
        </div>
      </div>

      {/* Rollback Confirmation Dialog */}
      <RollbackConfirmDialog
        open={showRollbackConfirm}
        onOpenChange={setShowRollbackConfirm}
        resourceTitle={selectedActivityForRollback?.resourceTitle ?? null}
        operation={(() => {
          const op = selectedActivityForRollback?.rollbackSourceOperation ?? selectedActivityForRollback?.operation ?? '';
          return operationLabels[op] || op;
        })()}
        timestamp={selectedActivityForRollback?.timestamp || new Date().toISOString()}
        preview={preview}
        action={action}
        onConfirm={handleConfirmAction}
      />
    </div>
  );
}
