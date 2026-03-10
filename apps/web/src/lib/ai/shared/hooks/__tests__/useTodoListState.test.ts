import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useTodoListState } from '../useTodoListState';

// Mock socket
const mockSocket = {
  on: vi.fn(),
  off: vi.fn(),
  emit: vi.fn(),
};

vi.mock('@/hooks/useSocket', () => ({
  useSocket: vi.fn(() => mockSocket),
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
  patch: vi.fn(),
}));

import { fetchWithAuth, patch } from '@/lib/auth/auth-fetch';

const mockFetchWithAuth = fetchWithAuth as ReturnType<typeof vi.fn>;
const mockPatch = patch as ReturnType<typeof vi.fn>;

describe('useTodoListState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          tasks: [
            {
              id: 'task-1',
              title: 'Test task',
              status: 'pending',
              priority: 'medium',
              position: 0,
            },
          ],
          taskList: {
            id: 'list-1',
            title: 'Test List',
            status: 'active',
          },
        }),
    });
    mockPatch.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('given initial state with non-todo message', () => {
    it('should not load tasks', async () => {
      const { result } = await act(async () => {
        return renderHook(() =>
          useTodoListState({
            messageId: 'msg-1',
            messageType: 'text',
          })
        );
      });

      expect(mockFetchWithAuth).not.toHaveBeenCalled();
      expect(result.current.tasks).toHaveLength(0);
      expect(result.current.taskList).toBeNull();
      expect(result.current.isLoadingTasks).toBe(false);
    });
  });

  describe('given todo_list message type', () => {
    it('should load tasks on mount', async () => {
      await act(async () => {
        renderHook(() =>
          useTodoListState({
            messageId: 'msg-1',
            messageType: 'todo_list',
          })
        );
      });

      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        '/api/ai/tasks/by-message/msg-1'
      );
    });

    it('should set loading state while fetching', async () => {
      let resolvePromise: (value: unknown) => void;
      mockFetchWithAuth.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvePromise = resolve;
          })
      );

      const { result } = renderHook(() =>
        useTodoListState({
          messageId: 'msg-1',
          messageType: 'todo_list',
        })
      );

      // Initially loading
      expect(result.current.isLoadingTasks).toBe(true);

      // Resolve the promise
      await act(async () => {
        resolvePromise!({
          ok: true,
          json: () =>
            Promise.resolve({
              tasks: [],
              taskList: null,
            }),
        });
      });

      // No longer loading
      expect(result.current.isLoadingTasks).toBe(false);
    });

    it('should populate tasks and taskList after fetch', async () => {
      const { result } = await act(async () => {
        return renderHook(() =>
          useTodoListState({
            messageId: 'msg-1',
            messageType: 'todo_list',
          })
        );
      });

      expect(result.current.tasks).toHaveLength(1);
      expect(result.current.tasks[0]?.title).toBe('Test task');
      expect(result.current.taskList?.id).toBe('list-1');
    });
  });

  describe('given handleTaskStatusUpdate called', () => {
    it('should call API and update local state', async () => {
      const onTaskUpdate = vi.fn();

      const { result } = await act(async () => {
        return renderHook(() =>
          useTodoListState({
            messageId: 'msg-1',
            messageType: 'todo_list',
            onTaskUpdate,
          })
        );
      });

      // Initial task has pending status
      expect(result.current.tasks[0]?.status).toBe('pending');

      await act(async () => {
        await result.current.handleTaskStatusUpdate('task-1', 'completed');
      });

      expect(mockPatch).toHaveBeenCalledWith('/api/ai/tasks/task-1/status', {
        status: 'completed',
      });

      expect(result.current.tasks[0]?.status).toBe('completed');
      expect(onTaskUpdate).toHaveBeenCalledWith('task-1', 'completed');
    });

    it('should handle update errors gracefully', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockPatch.mockRejectedValue(new Error('Update failed'));

      const { result } = await act(async () => {
        return renderHook(() =>
          useTodoListState({
            messageId: 'msg-1',
            messageType: 'todo_list',
          })
        );
      });

      await act(async () => {
        await result.current.handleTaskStatusUpdate('task-1', 'in_progress');
      });

      // Should log error but not crash
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Error updating task:',
        expect.any(Error)
      );

      consoleErrorSpy.mockRestore();
    });
  });

  describe('given socket events', () => {
    it('should register socket listeners for todo_list messages', async () => {
      await act(async () => {
        renderHook(() =>
          useTodoListState({
            messageId: 'msg-1',
            messageType: 'todo_list',
          })
        );
      });

      expect(mockSocket.on).toHaveBeenCalledWith(
        'task:task_updated',
        expect.any(Function)
      );
      expect(mockSocket.on).toHaveBeenCalledWith(
        'task:task_list_created',
        expect.any(Function)
      );
    });

    it('should not register socket listeners for non-todo messages', async () => {
      await act(async () => {
        renderHook(() =>
          useTodoListState({
            messageId: 'msg-1',
            messageType: 'text',
          })
        );
      });

      expect(mockSocket.on).not.toHaveBeenCalled();
    });

    it('should update task on task_updated event', async () => {
      let taskUpdatedHandler: ((payload: unknown) => void) | null = null;
      mockSocket.on.mockImplementation((event: string, handler: () => void) => {
        if (event === 'task:task_updated') {
          taskUpdatedHandler = handler;
        }
      });

      const { result } = await act(async () => {
        return renderHook(() =>
          useTodoListState({
            messageId: 'msg-1',
            messageType: 'todo_list',
          })
        );
      });

      // Trigger socket event
      await act(async () => {
        taskUpdatedHandler?.({
          taskId: 'task-1',
          data: { newStatus: 'in_progress' },
        });
      });

      expect(result.current.tasks[0]?.status).toBe('in_progress');
    });

    it('should cleanup socket listeners on unmount', async () => {
      const { unmount } = await act(async () => {
        return renderHook(() =>
          useTodoListState({
            messageId: 'msg-1',
            messageType: 'todo_list',
          })
        );
      });

      unmount();

      expect(mockSocket.off).toHaveBeenCalledWith(
        'task:task_updated',
        expect.any(Function)
      );
      expect(mockSocket.off).toHaveBeenCalledWith(
        'task:task_list_created',
        expect.any(Function)
      );
    });
  });

  describe('given fetch error', () => {
    it('should handle fetch errors gracefully', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockFetchWithAuth.mockRejectedValue(new Error('Network error'));

      const { result } = await act(async () => {
        return renderHook(() =>
          useTodoListState({
            messageId: 'msg-1',
            messageType: 'todo_list',
          })
        );
      });

      expect(result.current.isLoadingTasks).toBe(false);
      expect(result.current.tasks).toHaveLength(0);

      consoleErrorSpy.mockRestore();
    });
  });
});
