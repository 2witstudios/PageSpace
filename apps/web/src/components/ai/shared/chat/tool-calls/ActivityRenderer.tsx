'use client';

import React, { memo } from 'react';
import { useRouter } from 'next/navigation';
import {
  Activity,
  ExternalLink,
  Plus,
  Pencil,
  Trash2,
  Undo2,
  FolderInput,
  MessageSquare,
  Clock
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { PageTypeIcon } from '@/components/common/PageTypeIcon';
import { PageType } from '@pagespace/lib/client-safe';

type ActivityAction = 'created' | 'updated' | 'deleted' | 'restored' | 'moved' | 'commented' | 'renamed';

interface ActivityItem {
  id: string;
  action: ActivityAction;
  pageId?: string;
  pageTitle?: string;
  pageType?: string;
  driveId?: string;
  driveName?: string;
  actorName?: string;
  actorId?: string;
  timestamp?: string;
  summary?: string;
  diff?: string;
}

interface ActivityRendererProps {
  /** Activity items */
  activities: ActivityItem[];
  /** Time period description */
  period?: string;
  /** Title override */
  title?: string;
  /** Maximum height before scrolling */
  maxHeight?: number;
  /** Additional CSS class */
  className?: string;
}

const ACTION_CONFIG: Record<ActivityAction, { icon: React.ElementType; label: string; color: string }> = {
  created: { icon: Plus, label: 'created', color: 'text-green-600' },
  updated: { icon: Pencil, label: 'updated', color: 'text-blue-600' },
  deleted: { icon: Trash2, label: 'deleted', color: 'text-red-600' },
  restored: { icon: Undo2, label: 'restored', color: 'text-green-600' },
  moved: { icon: FolderInput, label: 'moved', color: 'text-purple-600' },
  commented: { icon: MessageSquare, label: 'commented on', color: 'text-orange-600' },
  renamed: { icon: Pencil, label: 'renamed', color: 'text-blue-600' },
};

function formatRelativeTime(timestamp: string): string {
  const date = new Date(timestamp);

  // Validate the date - check for Invalid Date
  if (isNaN(date.getTime())) {
    return timestamp; // Return original string if invalid
  }

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

/**
 * ActivityRenderer - Displays recent activity in a timeline format
 *
 * Features:
 * - Timeline-style layout
 * - Action-specific icons and colors
 * - Click to navigate to pages
 * - Relative timestamps
 */
export const ActivityRenderer: React.FC<ActivityRendererProps> = memo(function ActivityRenderer({
  activities,
  period,
  title = 'Recent Activity',
  maxHeight = 400,
  className
}) {
  const router = useRouter();

  const handleNavigate = (pageId?: string, driveId?: string) => {
    if (!pageId) return;
    if (driveId) {
      router.push(`/dashboard/${driveId}/${pageId}`);
    } else {
      router.push(`/p/${pageId}`);
    }
  };

  return (
    <div className={cn("rounded-lg border bg-card overflow-hidden my-2 shadow-sm", className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-muted/30 border-b">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">{title}</span>
        </div>
        <span className="text-xs text-muted-foreground">
          {period || `${activities.length} ${activities.length === 1 ? 'event' : 'events'}`}
        </span>
      </div>

      {/* Activity list */}
      <div
        className="bg-background overflow-auto"
        style={{ maxHeight: `${maxHeight}px` }}
      >
        {activities.length > 0 ? (
          <div className="divide-y divide-border">
            {activities.map((activity, index) => {
              const config = ACTION_CONFIG[activity.action] || ACTION_CONFIG.updated;
              const ActionIcon = config.icon;
              const canNavigate = activity.pageId && activity.action !== 'deleted';

              return (
                <div
                  key={activity.id || index}
                  className={cn(
                    "px-3 py-2.5",
                    canNavigate && "cursor-pointer hover:bg-muted/50 transition-colors group"
                  )}
                  onClick={() => canNavigate && handleNavigate(activity.pageId, activity.driveId)}
                >
                  <div className="flex items-start gap-3">
                    {/* Action icon */}
                    <div className={cn(
                      "flex items-center justify-center w-6 h-6 rounded-full shrink-0 mt-0.5",
                      "bg-muted"
                    )}>
                      <ActionIcon className={cn("h-3 w-3", config.color)} />
                    </div>

                    {/* Activity content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap text-sm">
                        {activity.actorName && (
                          <span className="font-medium">{activity.actorName}</span>
                        )}
                        <span className="text-muted-foreground">{config.label}</span>
                        {activity.pageTitle && (
                          <div className="flex items-center gap-1">
                            {activity.pageType && (
                              <PageTypeIcon
                                type={activity.pageType as PageType}
                                className="h-3.5 w-3.5 text-muted-foreground"
                              />
                            )}
                            <span className="font-medium truncate max-w-[200px]">
                              {activity.pageTitle}
                            </span>
                          </div>
                        )}
                      </div>

                      {/* Drive name */}
                      {activity.driveName && (
                        <div className="text-xs text-muted-foreground mt-0.5">
                          in {activity.driveName}
                        </div>
                      )}

                      {/* Summary/diff */}
                      {activity.summary && (
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                          {activity.summary}
                        </p>
                      )}

                      {/* Timestamp */}
                      {activity.timestamp && (
                        <div className="flex items-center gap-1 text-xs text-muted-foreground mt-1">
                          <Clock className="h-3 w-3" />
                          <span>{formatRelativeTime(activity.timestamp)}</span>
                        </div>
                      )}
                    </div>

                    {/* Navigate indicator */}
                    {canNavigate && (
                      <ExternalLink className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0 mt-1" />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground text-center py-6">
            <Activity className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p>No recent activity</p>
          </div>
        )}
      </div>
    </div>
  );
});
