'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Ban, X, ArrowRight, CircleSlash } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { post, del } from '@/lib/auth/auth-fetch';
import { cn } from '@/lib/utils';
import { TaskRelationPicker } from './TaskRelationPicker';
import type { DependencyRef } from './task-list-types';

/** Small inline "Blocked" badge for a task row title cell. */
export function BlockedBadge({ className }: { className?: string }) {
  return (
    <Badge
      className={cn(
        'gap-1 bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
        className,
      )}
      title="Blocked by an incomplete task"
    >
      <Ban className="h-3 w-3" />
      Blocked
    </Badge>
  );
}

interface DependencyChipProps {
  refItem: DependencyRef;
  driveId: string;
  canEdit: boolean;
  onRemove: () => void;
}

function DependencyChip({ refItem, driveId, canEdit, onRemove }: DependencyChipProps) {
  const router = useRouter();
  const done = refItem.completedAt !== null;
  return (
    <Badge
      variant="secondary"
      className={cn('max-w-[16rem] gap-1 pr-1', done && 'opacity-60')}
    >
      <button
        type="button"
        className="truncate hover:underline"
        onClick={() => refItem.pageId && router.push(`/dashboard/${driveId}/${refItem.pageId}`)}
        title={refItem.title}
      >
        <span className={cn(done && 'line-through')}>{refItem.title}</span>
      </button>
      {canEdit && (
        <button
          type="button"
          onClick={onRemove}
          className="ml-0.5 rounded p-0.5 hover:bg-muted-foreground/10"
          aria-label="Remove dependency"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </Badge>
  );
}

interface TaskDependenciesProps {
  taskId: string;
  /** TASK_LIST page id of the task's home list (used for the blocked-by mutations). */
  listPageId: string;
  driveId: string;
  blockedBy: DependencyRef[];
  blocks: DependencyRef[];
  canEdit: boolean;
  onChanged: () => void;
}

/**
 * Manage a task's blocker edges: shows "Blocked by" and "Blocks" chips with
 * remove buttons and a picker to add a blocker. Cross-list aware — a "Blocks"
 * edge is removed against the *blocked* task's home list.
 */
export function TaskDependencies({
  taskId,
  listPageId,
  driveId,
  blockedBy,
  blocks,
  canEdit,
  onChanged,
}: TaskDependenciesProps) {
  const [busy, setBusy] = useState(false);

  const addBlocker = async (blockerTaskId: string) => {
    setBusy(true);
    try {
      await post(`/api/pages/${listPageId}/tasks/${taskId}/dependencies`, { blockerTaskId });
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to add blocker');
    } finally {
      setBusy(false);
    }
  };

  const removeBlockedBy = async (ref: DependencyRef) => {
    setBusy(true);
    try {
      await del(`/api/pages/${listPageId}/tasks/${taskId}/dependencies/${ref.dependencyId}`);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to remove blocker');
    } finally {
      setBusy(false);
    }
  };

  // A "blocks" edge: this task is the blocker; the related task is blocked. The
  // DELETE route is keyed by the blocked task's home list page for permission.
  const removeBlocks = async (ref: DependencyRef) => {
    if (!ref.homeListPageId) return;
    setBusy(true);
    try {
      await del(`/api/pages/${ref.homeListPageId}/tasks/${ref.taskId}/dependencies/${ref.dependencyId}`);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to remove dependency');
    } finally {
      setBusy(false);
    }
  };

  const excludeIds = [taskId, ...blockedBy.map(b => b.taskId), ...blocks.map(b => b.taskId)];

  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
          <CircleSlash className="h-3.5 w-3.5" /> Blocked by
        </span>
        {blockedBy.length === 0 && (
          <span className="text-xs text-muted-foreground">nothing</span>
        )}
        {blockedBy.map((ref) => (
          <DependencyChip
            key={ref.dependencyId}
            refItem={ref}
            driveId={driveId}
            canEdit={canEdit && !busy}
            onRemove={() => removeBlockedBy(ref)}
          />
        ))}
        {canEdit && (
          <TaskRelationPicker
            driveId={driveId}
            excludeIds={excludeIds}
            onSelect={(id) => addBlocker(id)}
            placeholder="Add blocker"
            label="Search tasks to block this…"
            disabled={busy}
          />
        )}
      </div>

      {blocks.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
            <ArrowRight className="h-3.5 w-3.5" /> Blocks
          </span>
          {blocks.map((ref) => (
            <DependencyChip
              key={ref.dependencyId}
              refItem={ref}
              driveId={driveId}
              canEdit={canEdit && !busy && !!ref.homeListPageId}
              onRemove={() => removeBlocks(ref)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
