import { CheckCircle2, Clock, Circle, AlertCircle } from 'lucide-react';
import type { Task } from './useAggregatedTasks';

/**
 * Format a due date string into a user-friendly display with styling
 */
export const formatDueDate = (dateStr: string): { text: string; className: string } => {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    return { text: 'No date', className: 'text-muted-foreground' };
  }
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  const diffDays = Math.ceil((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays < 0) return { text: 'Overdue', className: 'text-red-500' };
  if (diffDays === 0) return { text: 'Today', className: 'text-amber-600 dark:text-amber-400' };
  if (diffDays === 1) return { text: 'Tomorrow', className: 'text-amber-600 dark:text-amber-400' };
  if (diffDays <= 7) return { text: `${diffDays}d`, className: 'text-muted-foreground' };

  return {
    text: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    className: 'text-muted-foreground'
  };
};

interface TaskStatusIconColors {
  completed?: string;
  in_progress?: string;
  blocked?: string;
  pending?: string;
}

const DEFAULT_COLORS: TaskStatusIconColors = {
  completed: 'text-green-600',
  in_progress: 'text-amber-500',
  blocked: 'text-red-600',
  pending: 'text-slate-400',
};

/**
 * Get the appropriate icon for a task status
 * @param status - The task status
 * @param size - Icon size class (default: 'w-3.5 h-3.5')
 * @param colors - Optional custom colors for each status
 */
export const getTaskStatusIcon = (
  status: Task['status'],
  size = 'w-3.5 h-3.5',
  colors: TaskStatusIconColors = DEFAULT_COLORS
) => {
  const mergedColors = { ...DEFAULT_COLORS, ...colors };
  switch (status) {
    case 'completed':
      return <CheckCircle2 className={`${size} ${mergedColors.completed}`} />;
    case 'in_progress':
      return <Clock className={`${size} ${mergedColors.in_progress}`} />;
    case 'blocked':
      return <AlertCircle className={`${size} ${mergedColors.blocked}`} />;
    case 'pending':
    default:
      return <Circle className={`${size} ${mergedColors.pending}`} />;
  }
};
