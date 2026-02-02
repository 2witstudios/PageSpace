'use client';

import React, { memo } from 'react';
import { useRouter } from 'next/navigation';
import {
  CheckCircle,
  XCircle,
  Plus,
  Pencil,
  Trash2,
  Undo2,
  ArrowRight,
  FolderInput,
  ExternalLink
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { PageTypeIcon } from '@/components/common/PageTypeIcon';
import { PageType } from '@pagespace/lib/client-safe';

type ActionType = 'create' | 'rename' | 'trash' | 'restore' | 'move' | 'update';

interface ActionResultRendererProps {
  /** Type of action performed */
  actionType: ActionType;
  /** Whether the action succeeded */
  success: boolean;
  /** Page title */
  title?: string;
  /** Page type */
  pageType?: string;
  /** Page ID for navigation */
  pageId?: string;
  /** Drive ID for navigation */
  driveId?: string;
  /** For rename: the old title */
  oldTitle?: string;
  /** For move: the old parent name */
  oldParent?: string;
  /** For move: the new parent name */
  newParent?: string;
  /** Error message if failed */
  errorMessage?: string;
  /** Additional message/summary */
  message?: string;
  /** Additional CSS class */
  className?: string;
}

const ACTION_CONFIG: Record<ActionType, { icon: React.ElementType; label: string; color: string }> = {
  create: { icon: Plus, label: 'Created', color: 'text-green-600' },
  rename: { icon: Pencil, label: 'Renamed', color: 'text-blue-600' },
  trash: { icon: Trash2, label: 'Moved to Trash', color: 'text-orange-600' },
  restore: { icon: Undo2, label: 'Restored', color: 'text-green-600' },
  move: { icon: FolderInput, label: 'Moved', color: 'text-purple-600' },
  update: { icon: Pencil, label: 'Updated', color: 'text-blue-600' },
};

/**
 * ActionResultRenderer - Shows the result of page/drive actions
 *
 * Features:
 * - Clear success/failure indication
 * - Action-specific icons and colors
 * - Shows before/after for rename/move
 * - Click to navigate to page
 */
export const ActionResultRenderer: React.FC<ActionResultRendererProps> = memo(function ActionResultRenderer({
  actionType,
  success,
  title,
  pageType,
  pageId,
  driveId,
  oldTitle,
  oldParent,
  newParent,
  errorMessage,
  message,
  className
}) {
  const router = useRouter();
  const config = ACTION_CONFIG[actionType] || ACTION_CONFIG.update;
  const ActionIcon = config.icon;

  const handleNavigate = () => {
    if (pageId && driveId) {
      router.push(`/dashboard/${driveId}/${pageId}`);
    } else if (pageId) {
      router.push(`/p/${pageId}`);
    }
  };

  const canNavigate = success && pageId && actionType !== 'trash';

  return (
    <div className={cn("rounded-lg border bg-card overflow-hidden my-2 shadow-sm", className)}>
      {/* Header with status */}
      <div className={cn(
        "flex items-center gap-2 px-3 py-2 border-b",
        success ? "bg-green-500/5" : "bg-red-500/5"
      )}>
        {success ? (
          <CheckCircle className="h-4 w-4 text-green-600 shrink-0" />
        ) : (
          <XCircle className="h-4 w-4 text-red-600 shrink-0" />
        )}
        <span className={cn(
          "text-sm font-medium",
          success ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"
        )}>
          {success ? 'Success' : 'Failed'}
        </span>
      </div>

      {/* Content */}
      <div className="p-3">
        {/* Main action display */}
        <div
          className={cn(
            "flex items-center gap-3",
            canNavigate && "cursor-pointer hover:bg-muted/50 -mx-2 px-2 py-1 rounded-md transition-colors group"
          )}
          onClick={canNavigate ? handleNavigate : undefined}
        >
          {/* Action icon */}
          <div className={cn(
            "flex items-center justify-center w-8 h-8 rounded-md shrink-0",
            success ? "bg-muted" : "bg-red-500/10"
          )}>
            <ActionIcon className={cn("h-4 w-4", success ? config.color : "text-red-600")} />
          </div>

          {/* Action details */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm text-muted-foreground">{config.label}</span>

              {/* Page icon + title */}
              {title && (
                <div className="flex items-center gap-1.5">
                  {pageType && (
                    <PageTypeIcon
                      type={pageType as PageType}
                      className="h-4 w-4 text-muted-foreground shrink-0"
                    />
                  )}
                  <span className="text-sm font-medium truncate">{title}</span>
                </div>
              )}
            </div>

            {/* Rename: show old → new */}
            {actionType === 'rename' && oldTitle && title && (
              <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                <span className="truncate max-w-[120px]">{oldTitle}</span>
                <ArrowRight className="h-3 w-3 shrink-0" />
                <span className="truncate max-w-[120px] text-foreground">{title}</span>
              </div>
            )}

            {/* Move: show old parent → new parent */}
            {actionType === 'move' && (oldParent || newParent) && (
              <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                <span className="truncate max-w-[100px]">{oldParent || 'Root'}</span>
                <ArrowRight className="h-3 w-3 shrink-0" />
                <span className="truncate max-w-[100px] text-foreground">{newParent || 'Root'}</span>
              </div>
            )}
          </div>

          {/* Navigate indicator */}
          {canNavigate && (
            <ExternalLink className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
          )}
        </div>

        {/* Error message */}
        {!success && errorMessage && (
          <div className="mt-2 text-xs text-red-600 dark:text-red-400 bg-red-500/5 px-2 py-1.5 rounded">
            {errorMessage}
          </div>
        )}

        {/* Additional message */}
        {message && success && (
          <div className="mt-2 text-xs text-muted-foreground">
            {message}
          </div>
        )}
      </div>
    </div>
  );
});
