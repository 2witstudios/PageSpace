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
import { EventAgentTriggerDialog } from '../EventAgentTriggerDialog';

const EVENT_ID = 'evt-1';
const DRIVE_ID = 'drive-1';
const TRIGGER_URL = `/api/calendar/events/${EVENT_ID}/triggers`;

const remoteTrigger = () => ({
  id: 'trig-1',
  agentPageId: 'agent-1',
  prompt: 'remote-prompt',
  instructionPageId: null,
  contextPageIds: [],
  lastFiredAt: null,
  lastFireError: null,
  lastRunStatus: null,
});

const remoteAgent = () => ({ id: 'agent-1', title: 'Triage Bot' });

const cannedFetch = (triggerOverride?: unknown) =>
  vi.mocked(fetchWithAuth).mockImplementation(async (...args: unknown[]) => {
    const url = String(args[0]);
    if (url.endsWith('/triggers')) {
      return new Response(JSON.stringify({ trigger: triggerOverride ?? remoteTrigger() }), {
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
      <EventAgentTriggerDialog
        open
        onOpenChange={() => {}}
        eventId={EVENT_ID}
        eventTitle="Standup"
        driveId={DRIVE_ID}
      />
    </SWRConfig>,
  );

describe('EventAgentTriggerDialog — editing-store contract', () => {
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
      await globalMutate(TRIGGER_URL);
      await new Promise((r) => setTimeout(r, 50));
    });

    assert({
      given: 'a remote calendar broadcast arrives while the dialog is open with unsaved prompt text',
      should: 'preserve the in-progress prompt text rather than refetching and clobbering it',
      actual: promptInput.value,
      expected: 'in-flight typing',
    });
  });

  test('shows the empty (no-trigger) state when the GET returns trigger=null', async () => {
    cannedFetch(null);

    renderDialog();

    await waitFor(() => {
      // The "Run agent at event start" label is present even when no trigger
      // exists yet; the form expands once the user toggles the switch.
      screen.getByText(/Run agent at event start/i);
    });

    assert({
      given: 'no trigger exists on this event yet',
      should: 'render the toggle in its disabled-form state (no Save button visible)',
      actual: screen.queryByRole('button', { name: /^Save$/i }),
      expected: null,
    });
  });
});
