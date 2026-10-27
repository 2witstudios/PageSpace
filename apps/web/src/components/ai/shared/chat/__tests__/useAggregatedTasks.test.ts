import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { useAggregatedTasks, TASK_TOOL_NAMES } from '../useAggregatedTasks';

interface TaskToolPartInit {
  toolName: string;
  toolCallId?: string;
  state?: string;
  output?: unknown;
  errorText?: string;
}

/** Build a single-message conversation whose parts are task tool calls. */
function messagesWith(parts: TaskToolPartInit[]): UIMessage[] {
  return [
    {
      id: 'msg-1',
      role: 'assistant',
      parts: parts.map((p) => ({ type: `tool-${p.toolName}`, ...p })),
    } as unknown as UIMessage,
  ];
}

/** Shared task/taskList/tasks response shape emitted by every task verb tool. */
function taskOutput(
  action: 'created' | 'updated' | 'deleted',
  tasks: Array<{ id: string; title: string; status: string; position: number }>,
) {
  return {
    success: true,
    action,
    taskList: { id: 'list-1', title: 'My Tasks', status: 'pending', pageId: 'tl-page-1' },
    tasks,
    task: tasks[0] ? { id: tasks[0].id, title: tasks[0].title, status: tasks[0].status } : undefined,
    message: `task ${action}`,
  };
}

describe('useAggregatedTasks', () => {
  it('exposes all four task verb tools', () => {
    expect([...TASK_TOOL_NAMES].sort()).toEqual(
      ['create_task', 'delete_task', 'reorder_task', 'update_task'],
    );
  });

  it('ignores non-task tool parts', () => {
    const { result } = renderHook(() =>
      useAggregatedTasks(
        messagesWith([
          { toolName: 'read_page', state: 'output-available', output: { success: true, tasks: [{ id: 't', title: 'x', status: 'pending', position: 0 }] } },
        ]),
      ),
    );
    expect(result.current.hasTaskData).toBe(false);
    expect(result.current.tasks).toEqual([]);
  });

  it('aggregates a create_task output (new verb, not update_task)', () => {
    const { result } = renderHook(() =>
      useAggregatedTasks(
        messagesWith([
          {
            toolName: 'create_task',
            state: 'output-available',
            output: taskOutput('created', [{ id: 't1', title: 'First', status: 'pending', position: 0 }]),
          },
        ]),
      ),
    );
    expect(result.current.hasTaskData).toBe(true);
    expect(result.current.tasks.map((t) => t.id)).toEqual(['t1']);
    expect(result.current.taskList?.id).toBe('list-1');
  });

  it('reflects reorder_task output ordering by position', () => {
    const { result } = renderHook(() =>
      useAggregatedTasks(
        messagesWith([
          {
            toolName: 'reorder_task',
            state: 'output-available',
            output: taskOutput('updated', [
              { id: 't2', title: 'Second', status: 'pending', position: 0 },
              { id: 't1', title: 'First', status: 'pending', position: 1 },
            ]),
          },
        ]),
      ),
    );
    expect(result.current.tasks.map((t) => t.id)).toEqual(['t2', 't1']);
  });

  it('drops a task removed by delete_task (full-snapshot replace, not merge)', () => {
    const { result } = renderHook(() =>
      useAggregatedTasks(
        messagesWith([
          // create_task established two tasks...
          {
            toolName: 'create_task',
            toolCallId: 'call-1',
            state: 'output-available',
            output: taskOutput('updated', [
              { id: 't1', title: 'First', status: 'pending', position: 0 },
              { id: 't2', title: 'Second', status: 'pending', position: 1 },
            ]),
          },
          // ...then delete_task returns the shorter remaining list (t2 gone).
          {
            toolName: 'delete_task',
            toolCallId: 'call-2',
            state: 'output-available',
            output: {
              success: true,
              action: 'deleted',
              taskList: { id: 'list-1', title: 'My Tasks', status: 'pending', pageId: 'tl-page-1' },
              tasks: [{ id: 't1', title: 'First', status: 'pending', position: 0 }],
              task: { id: 't2', title: 'Second', status: 'pending' },
              message: 'task deleted',
            },
          },
        ]),
      ),
    );
    // The deleted task must NOT linger from the earlier snapshot.
    expect(result.current.tasks.map((t) => t.id)).toEqual(['t1']);
  });

  it('tracks loading state across update_task verb call', () => {
    const { result } = renderHook(() =>
      useAggregatedTasks(
        messagesWith([
          { toolName: 'update_task', toolCallId: 'call-1', state: 'input-available' },
        ]),
      ),
    );
    expect(result.current.isLoading).toBe(true);
  });

  it('surfaces error state on output-error for a verb tool', () => {
    const { result } = renderHook(() =>
      useAggregatedTasks(
        messagesWith([
          { toolName: 'delete_task', toolCallId: 'call-1', state: 'output-error', errorText: 'boom' },
        ]),
      ),
    );
    expect(result.current.hasError).toBe(true);
    expect(result.current.errorMessage).toBe('boom');
  });
});
