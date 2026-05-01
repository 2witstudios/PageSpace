import { describe, test, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SWRConfig, mutate as globalMutate } from 'swr';
import { assert } from '@/stores/__tests__/riteway';
import { useEditingStore } from '@/stores/useEditingStore';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}));

import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { TaskAgentTriggersDialog } from '../TaskAgentTriggersDialog';

const TASK_ID = 'task-1';
const PAGE_ID = 'page-1';
const DRIVE_ID = 'drive-1';
const TRIGGERS_URL = `/api/tasks/${TASK_ID}/triggers`;

const remoteTrigger = () => ({
  id: 'trig-1',
  triggerType: 'task_due_date' as const,
  agentPageId: 'agent-1',
  prompt: 'remote-prompt',
  isEnabled: true,
  lastRunStatus: 'never_run' as const,
  lastRunAt: null,
});

const remoteAgent = () => ({ id: 'agent-1', title: 'Triage Bot' });

const cannedFetch = () =>
  vi.mocked(fetchWithAuth).mockImplementation(async (...args: unknown[]) => {
    const url = String(args[0]);
    if (url.endsWith('/triggers')) {
      return new Response(JSON.stringify({ triggers: [remoteTrigger()] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/agents')) {
      return new Response(JSON.stringify({ agents: [remoteAgent()] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200 });
  });

const renderDialog = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <TaskAgentTriggersDialog
        open
        onOpenChange={() => {}}
        taskId={TASK_ID}
        taskTitle="Some task"
        pageId={PAGE_ID}
        driveId={DRIVE_ID}
        hasDueDate
      />
    </SWRConfig>,
  );

describe('TaskAgentTriggersDialog — editing-store contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useEditingStore.getState().clearAllSessions();
    cannedFetch();
  });

  test('preserves in-flight prompt text across a remote refetch', async () => {
    renderDialog();

    const promptInput = (await waitFor(() =>
      screen.getByDisplayValue('remote-prompt'),
    )) as HTMLTextAreaElement;

    await userEvent.clear(promptInput);
    await userEvent.type(promptInput, 'in-flight typing');

    assert({
      given: 'the user has typed into the prompt textarea while the dialog is open',
      should: 'show the typed text in the textarea (sanity check before remote refetch)',
      actual: promptInput.value,
      expected: 'in-flight typing',
    });

    await act(async () => {
      await globalMutate(TRIGGERS_URL);
      await new Promise((r) => setTimeout(r, 50));
    });

    assert({
      given: 'a remote task_updated arrives while the dialog is open with unsaved prompt text',
      should: 'preserve the in-progress prompt text rather than refetching and clobbering it',
      actual: promptInput.value,
      expected: 'in-flight typing',
    });
  });
});
