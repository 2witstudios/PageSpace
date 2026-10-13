'use client';

import dynamic from 'next/dynamic';
import { Plus, Zap } from 'lucide-react';
import { ToolbarStrip } from '@/ui/frame/toolbar-strip/toolbar-strip';
import { Button } from '@/retained/components/ui/button';
import type { TaskListPageFilter } from '@/retained/stores/useLayoutStore';
import type { TaskListToolsControls } from '@/retained/components/layout/middle-content/page-views/task-list/TaskListView';
import type { PageTypeProps } from './shared';

const TaskListView = dynamic(() => import('@/retained/components/layout/middle-content/page-views/task-list/TaskListView'), { ssr: false });

const FILTERS: readonly { readonly value: TaskListPageFilter; readonly label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' },
  { value: 'all', label: 'All' },
];

const segmentClass = 'flex items-center rounded-md px-2 py-1 text-sm font-medium transition-colors';
const segmentSelected = 'bg-tint text-ink';
const segmentIdle = 'text-ink-muted';

/**
 * The 44px List controls strip (C-Files-TaskList): the View group (Table, Board), the Status
 * group (Active, Completed, All), the filter box, status settings, Workflows for drive managers
 * and + Task. The board's Assignee and Due menus are not here: classic has no filter for either,
 * and this strip does not invent one.
 */
export function TaskListToolsStrip({ controls }: { readonly controls: TaskListToolsControls }) {
  const isTable = controls.viewMode === 'table';
  const isBoard = controls.viewMode === 'kanban';
  return (
    <ToolbarStrip label="List controls">
      <div role="group" aria-label="View" className="flex rounded-lg bg-fill p-1">
        <button
          type="button"
          aria-current={isTable ? 'page' : undefined}
          onClick={() => controls.onViewModeChange('table')}
          className={`${segmentClass} ${isTable ? segmentSelected : segmentIdle}`}
        >
          Table
        </button>
        <button
          type="button"
          aria-current={isBoard ? 'page' : undefined}
          onClick={() => controls.onViewModeChange('kanban')}
          className={`${segmentClass} ${isBoard ? segmentSelected : segmentIdle}`}
        >
          Board
        </button>
      </div>
      <span aria-hidden="true" className="mx-1 h-4 w-px border-l border-hairline" />
      <div role="group" aria-label="Status group" className="flex gap-1">
        {FILTERS.map((option) => {
          const selected = controls.filter === option.value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              onClick={() => controls.onFilterChange(option.value)}
              className={`${segmentClass} ${selected ? segmentSelected : segmentIdle}`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      <div className="ml-2">{controls.searchField}</div>
      <div className="flex-1" />
      {controls.statusSettings}
      {controls.canManageWorkflows && (
        <Button variant="ghost" size="sm" onClick={controls.onOpenWorkflows} className="ml-1 gap-1">
          <Zap className="h-4 w-4" aria-hidden="true" />
          Workflows
        </Button>
      )}
      {controls.canEdit && (
        <Button size="sm" onClick={controls.onNewTask} className="ml-1 gap-1">
          <Plus className="h-4 w-4" aria-hidden="true" />
          Task
        </Button>
      )}
    </ToolbarStrip>
  );
}

/** Module-level so TaskListView's memo sees one stable renderer, not a new closure per render. */
function renderTaskListTools(controls: TaskListToolsControls) {
  return <TaskListToolsStrip controls={controls} />;
}

/** A task list in the v3 middle (C-Files-TaskList): its List controls strip, then classic's list. */
export function TaskListPage({ page }: PageTypeProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <TaskListView page={page} renderTools={renderTaskListTools} />
    </div>
  );
}
