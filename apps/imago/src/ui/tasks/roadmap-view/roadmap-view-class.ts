import { cn } from '../../cn';
import type { StatusGroup } from '../task-model/task';

/* The Roadmap: its own controls over lanes on the left and the timeline on
   the right, then the tray of unscheduled tasks. */
export const roadmapClass = 'flex w-full min-w-0 flex-col gap-3';

export const roadmapControlsClass = 'flex flex-wrap items-center gap-2';

export const roadmapStepClass = 'flex items-center gap-1';

export const roadmapTodayClass =
  'rounded-md px-2 py-1 text-xs font-medium text-ink-muted hover:bg-surface-overlay hover:text-ink';

export const roadmapNoticeClass = 'text-2xs font-medium text-live';

/** Lanes and timeline side by side, ruled as one table. */
export const roadmapGridClass = 'flex min-w-0 overflow-hidden rounded-lg border border-hairline bg-background';

/* The lane list stays put while the timeline scrolls across beside it. */
export const roadmapLanesClass = 'flex w-roadmap-lanes flex-none flex-col border-r border-hairline';

export const roadmapLanesHeadClass =
  'flex h-roadmap-head flex-none items-end border-b border-hairline px-3 pb-2 text-2xs font-semibold text-ink-faint';

const laneIndents = ['pl-3', 'pl-6', 'pl-10', 'pl-12', 'pl-16'] as const;

/** A lane: its dot and title, stepped in by depth. */
export const roadmapLaneClass = (depth: number): string =>
  cn(
    'flex h-roadmap-row min-w-0 items-center gap-2 border-b border-hairline pr-3 text-sm',
    laneIndents[Math.min(depth, laneIndents.length - 1)],
  );

const dotTones: Readonly<Record<StatusGroup, string>> = {
  todo: 'bg-ink-faint',
  in_progress: 'bg-accent',
  done: 'bg-status-success',
};

export const roadmapDotClass = (group: StatusGroup): string =>
  cn('size-live-dot flex-none rounded-round', dotTones[group]);

export const roadmapLaneTitleClass = (done: boolean): string =>
  cn('min-w-0 truncate', done ? 'text-ink-faint line-through' : 'text-ink');

export const roadmapTimelineClass = 'relative min-w-0 flex-1 overflow-x-auto';

/** The drawn days; its width and height are set from the range. */
export const roadmapCanvasClass = 'relative';

export const roadmapHeadClass = 'relative h-roadmap-head border-b border-hairline';

export const roadmapMonthClass =
  'absolute top-1 truncate pl-1 text-2xs font-semibold whitespace-nowrap text-ink-muted';

export const roadmapTickClass = (weekend: boolean): string =>
  cn(
    'absolute bottom-1 border-l border-hairline pl-1 text-2xs tabular-nums',
    weekend ? 'text-ink-faint' : 'text-ink-muted',
  );

export const roadmapWeekendClass = 'absolute bottom-0 bg-surface-sunken';

export const roadmapRowClass = 'relative h-roadmap-row border-b border-hairline';

export const roadmapTodayLineClass = 'pointer-events-none absolute top-0 bottom-0 z-popover w-px bg-accent';

export const roadmapTodayLabelClass =
  'pointer-events-none absolute top-1 z-popover -translate-x-1/2 rounded-sm bg-accent px-1 text-2xs font-medium text-accent-ink';

const barTones: Readonly<Record<StatusGroup, string>> = {
  todo: 'border-border-strong bg-fill',
  in_progress: 'border-accent bg-accent-soft',
  done: 'border-status-success/40 bg-status-success/10',
};

/** A task's bar, tinted by its status group; it grabs to move when it can. */
export const roadmapBarClass = (group: StatusGroup, editable: boolean): string =>
  cn(
    'absolute top-2 flex h-roadmap-bar overflow-hidden rounded-sm border',
    barTones[group],
    editable && 'cursor-grab touch-none',
  );

const fillTones: Readonly<Record<StatusGroup, string>> = {
  todo: 'bg-border-strong',
  in_progress: 'bg-accent/30',
  done: 'bg-status-success/30',
};

/** How much of the bar is done; its width is set from the progress. */
export const roadmapFillClass = (group: StatusGroup): string =>
  cn('pointer-events-none absolute inset-y-0 left-0', fillTones[group]);

/** The days a task has run late, past its due date up to today. */
export const roadmapOverdueClass =
  'pointer-events-none absolute top-2 h-roadmap-bar rounded-sm border border-live roadmap-hatch';

const milestoneTones: Readonly<Record<StatusGroup, string>> = {
  todo: 'border-border-strong bg-fill',
  in_progress: 'border-accent bg-accent-soft',
  done: 'border-status-success bg-status-success/30',
};

/** A subtask's milestone: a diamond on its due day. */
export const roadmapMilestoneClass = (group: StatusGroup, editable: boolean): string =>
  cn(
    'absolute top-1/2 size-roadmap-milestone -translate-x-1/2 -translate-y-1/2 rotate-45 border',
    milestoneTones[group],
    editable && 'cursor-grab touch-none',
  );

/** The edge a bar's dates are dragged by. */
export const roadmapHandleClass = (edge: 'start' | 'due'): string =>
  cn(
    'absolute inset-y-0 z-popover w-roadmap-handle cursor-ew-resize touch-none hover:bg-accent/30 focus-visible:bg-accent/30',
    edge === 'start' ? 'left-0' : 'right-0',
  );

/** Where a dragged bar will land. */
export const roadmapGhostClass =
  'pointer-events-none absolute top-2 z-popover h-roadmap-bar rounded-sm border border-dashed border-accent bg-accent-soft';

export const roadmapTooltipClass =
  'pointer-events-none absolute bottom-full z-popover mb-1 rounded-md border border-hairline px-2 py-1 text-2xs font-medium whitespace-nowrap text-ink shadow-2 surface-glass-raised';

export const roadmapEmptyClass = 'px-3 py-4 text-sm text-ink-faint';

/* The tray: tasks with no due date, as chips. */
export const roadmapTrayClass = 'flex flex-col gap-2';

export const roadmapTrayHeadClass = 'text-2xs font-semibold text-ink-faint';

export const roadmapTrayListClass = 'flex flex-wrap gap-2';

export const roadmapChipClass =
  'flex items-center gap-2 rounded-md border border-hairline bg-surface-overlay px-2 py-1 text-xs text-ink';

export const roadmapScheduleClass =
  'rounded-sm px-1 text-2xs font-medium text-accent hover:bg-accent-soft';
