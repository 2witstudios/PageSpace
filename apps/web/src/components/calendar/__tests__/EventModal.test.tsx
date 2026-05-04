import { describe, test, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SWRConfig, mutate as globalMutate } from 'swr';
import { assert } from '@/stores/__tests__/riteway';
import { useEditingStore } from '@/stores/useEditingStore';
import { CalendarEvent } from '../calendar-types';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
}));

// TriggerPagePicker fetches from auth-fetch internally; stub it so the
// Advanced disclosure doesn't crash trying to load pages mid-test.
vi.mock(
  '@/components/layout/middle-content/page-views/task-list/TriggerPagePicker',
  () => ({
    TriggerPagePicker: () => null,
  }),
);

import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { EventModal } from '../EventModal';

const DRIVE_ID = 'drive-1';
const EVENT_ID = 'evt-1';
const TRIGGER_URL = `/api/calendar/events/${EVENT_ID}/triggers`;

const remoteAgent = () => ({ id: 'agent-1', title: 'Triage Bot' });

const remoteTrigger = () => ({
  id: 'trig-1',
  agentPageId: 'agent-1',
  prompt: 'remote-prompt',
  instructionPageId: null,
  contextPageIds: [],
  lastFiredAt: null,
  lastFireError: null,
});

const baseEvent = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: EVENT_ID,
  driveId: DRIVE_ID,
  createdById: 'user-1',
  pageId: null,
  title: 'Standup',
  description: null,
  location: null,
  startAt: '2026-05-04T15:00:00Z',
  endAt: '2026-05-04T16:00:00Z',
  allDay: false,
  timezone: 'UTC',
  recurrenceRule: null,
  visibility: 'DRIVE',
  color: 'default',
  syncedFromGoogle: false,
  googleSyncReadOnly: null,
  createdAt: '2026-05-04T00:00:00Z',
  updatedAt: '2026-05-04T00:00:00Z',
  createdBy: { id: 'user-1', name: 'Test', image: null },
  attendees: [],
  ...overrides,
});

const cannedFetch = (opts: { trigger?: unknown; agents?: unknown } = {}) =>
  vi.mocked(fetchWithAuth).mockImplementation(async (...args: unknown[]) => {
    const url = String(args[0]);
    if (url.endsWith('/triggers')) {
      return new Response(
        JSON.stringify({ trigger: opts.trigger === undefined ? remoteTrigger() : opts.trigger }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.endsWith('/agents')) {
      return new Response(
        JSON.stringify({ agents: opts.agents ?? [remoteAgent()] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response('{}', { status: 200 });
  });

interface RenderOpts {
  event?: CalendarEvent | null;
  context?: 'user' | 'drive';
  driveId?: string;
  onSave?: (data: unknown) => Promise<void>;
}

const renderModal = (opts: RenderOpts = {}) => {
  const onSave = opts.onSave ?? (async () => undefined);
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <EventModal
        isOpen
        onClose={() => {}}
        event={opts.event ?? null}
        defaultValues={null}
        onSave={onSave}
        driveId={opts.driveId ?? DRIVE_ID}
        context={opts.context ?? 'drive'}
      />
    </SWRConfig>,
  );
};

const firstSavePayload = async (
  onSave: ReturnType<typeof vi.fn>,
): Promise<{ agentTrigger?: unknown }> => {
  await waitFor(() => {
    if (!onSave.mock.calls.length) throw new Error('onSave not called');
  });
  return onSave.mock.calls[0][0] as { agentTrigger?: unknown };
};

describe('EventModal — agent trigger disclosure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useEditingStore.getState().clearAllSessions();
    cannedFetch();
  });

  test('hides agent disclosure entirely for personal events', async () => {
    renderModal({ context: 'user', driveId: undefined, event: null });

    await waitFor(() => {
      screen.getByText(/New Event/i);
    });

    assert({
      given: 'a personal calendar context (no driveId)',
      should: 'not render the Agent trigger disclosure button',
      actual: screen.queryByRole('button', { name: /Agent trigger/i }),
      expected: null,
    });
  });

  test('renders agent disclosure collapsed by default with Off label', async () => {
    cannedFetch({ trigger: null });

    renderModal({ event: null });

    const trigger = await screen.findByRole('button', { name: /Agent trigger\s*Off/i });

    assert({
      given: 'a new drive event with no trigger configured',
      should: 'render the disclosure header collapsed and labeled "Off"',
      actual: !!trigger,
      expected: true,
    });

    assert({
      given: 'a collapsed disclosure',
      should: 'not show the inline AgentTriggerSection (Run agent at event start label hidden)',
      actual: screen.queryByText(/Run agent at event start/i),
      expected: null,
    });
  });

  test('prefills agent value and header label when editing an event with an existing trigger', async () => {
    renderModal({ event: baseEvent() });

    await waitFor(() => {
      screen.getByRole('button', { name: /Agent trigger\s*Triage Bot at start/i });
    });

    assert({
      given: 'an event whose trigger row resolves to agent "Triage Bot"',
      should: 'show that agent name in the disclosure header',
      actual: !!screen.queryByRole('button', { name: /Triage Bot at start/i }),
      expected: true,
    });
  });

  test('shows recurring-event note instead of the form when event is recurring', async () => {
    cannedFetch({ trigger: null });

    renderModal({
      event: baseEvent({
        recurrenceRule: { frequency: 'WEEKLY', interval: 1 },
      }),
    });

    const triggerHeader = await screen.findByRole('button', { name: /Agent trigger/i });
    await userEvent.click(triggerHeader);

    await waitFor(() => {
      screen.getByText(/Recurring events can.+t have agent triggers/i);
    });

    assert({
      given: 'a recurring drive event with the Agent trigger disclosure expanded',
      should: 'show the "can\'t have agent triggers" note instead of the form',
      actual: screen.queryByText(/Run agent at event start/i),
      expected: null,
    });
  });

  test('Advanced section is collapsed by default and hides Linked page until expanded', async () => {
    cannedFetch({ trigger: null });

    renderModal({ event: null });

    const advancedTrigger = await screen.findByRole('button', { name: /Advanced/i });

    assert({
      given: 'a drive event modal',
      should: 'collapse the Advanced section by default so casual users see only normal calendar fields',
      actual: !!advancedTrigger,
      expected: true,
    });

    // Linked page label should not be visible while collapsed.
    assert({
      given: 'a collapsed Advanced section',
      should: 'not surface the Linked page label',
      actual: screen.queryByText(/^Linked page$/i),
      expected: null,
    });
  });

  test('saving with agent enabled forwards a complete agentTrigger payload to onSave', async () => {
    const onSave = vi.fn<(data: unknown) => Promise<void>>(async () => undefined);
    renderModal({ event: baseEvent(), onSave });

    const header = await screen.findByRole('button', { name: /Triage Bot at start/i });
    await userEvent.click(header);

    await screen.findByDisplayValue('remote-prompt');

    await userEvent.click(screen.getByRole('button', { name: /^Update$/i }));

    const payload = await firstSavePayload(onSave);

    assert({
      given: 'an event with an existing trigger and the user clicks Update without changing anything',
      should: 'call onSave with an agentTrigger object that mirrors the existing trigger (idempotent upsert)',
      actual: payload.agentTrigger,
      expected: {
        agentPageId: 'agent-1',
        prompt: 'remote-prompt',
        instructionPageId: null,
        contextPageIds: [],
      },
    });
  });

  test('saving with toggle off + existing trigger forwards agentTrigger=null to onSave', async () => {
    const onSave = vi.fn<(data: unknown) => Promise<void>>(async () => undefined);
    renderModal({ event: baseEvent(), onSave });

    const header = await screen.findByRole('button', { name: /Triage Bot at start/i });
    await userEvent.click(header);

    // Wait for the form to render then flip the enable toggle off
    const toggle = await screen.findByRole('switch', { name: /Run agent at event start/i });
    await userEvent.click(toggle);

    await userEvent.click(screen.getByRole('button', { name: /^Update$/i }));

    const payload = await firstSavePayload(onSave);

    assert({
      given: 'an existing trigger with the toggle flipped off',
      should: 'call onSave with agentTrigger=null so the API removes the trigger',
      actual: payload.agentTrigger,
      expected: null,
    });
  });

  test('a recurring event with a stale trigger row leaves it alone on save (agentTrigger=undefined)', async () => {
    // Defensive case: the API rejects upserting triggers on recurring events,
    // so a recurring row with a trigger should never exist. If one does, the
    // modal must not surface it as enabled (would trap the user behind a
    // recurring-validation error) and must not silently send agentTrigger=null
    // either (that would delete the row without user intent).
    const onSave = vi.fn<(data: unknown) => Promise<void>>(async () => undefined);

    renderModal({
      event: baseEvent({
        recurrenceRule: { frequency: 'WEEKLY', interval: 1 },
      }),
      onSave,
    });

    // Disclosure header should read 'Off' even though a trigger row exists,
    // because hydration skips recurring events.
    await screen.findByRole('button', { name: /Agent trigger\s*Off/i });

    await userEvent.click(screen.getByRole('button', { name: /^Update$/i }));

    const payload = await firstSavePayload(onSave);

    assert({
      given: 'a recurring event with a stale trigger row',
      should: 'send agentTrigger=undefined (no-op) so the broken row is left alone, not deleted',
      actual: payload.agentTrigger,
      expected: undefined,
    });
  });

  test('saving on a personal event omits agentTrigger entirely', async () => {
    const onSave = vi.fn<(data: unknown) => Promise<void>>(async () => undefined);
    renderModal({ context: 'user', driveId: undefined, event: null, onSave });

    // Title is required
    const titleInput = await screen.findByLabelText(/Title/i);
    await userEvent.type(titleInput, 'Solo lunch');

    await userEvent.click(screen.getByRole('button', { name: /^Create$/i }));

    const payload = await firstSavePayload(onSave);

    assert({
      given: 'a personal calendar create flow',
      should: 'omit agentTrigger from the onSave payload (undefined, not null)',
      actual: payload.agentTrigger,
      expected: undefined,
    });
  });

  test('preserves in-flight prompt text across a remote refetch (editing-store contract)', async () => {
    renderModal({ event: baseEvent() });

    // Disclosure auto-expands when there's an existing trigger? No — it stays collapsed
    // by design. Open it.
    const header = await screen.findByRole('button', { name: /Agent trigger/i });
    await userEvent.click(header);

    const promptInput = (await waitFor(() =>
      screen.getByDisplayValue('remote-prompt'),
    )) as HTMLTextAreaElement;

    await userEvent.clear(promptInput);
    await userEvent.type(promptInput, 'in-flight typing');

    assert({
      given: 'the user has typed into the prompt textarea while the modal is open',
      should: 'show the typed text (sanity check before refetch)',
      actual: promptInput.value,
      expected: 'in-flight typing',
    });

    await act(async () => {
      await globalMutate(TRIGGER_URL);
      await new Promise((r) => setTimeout(r, 50));
    });

    assert({
      given: 'a remote calendar broadcast arrives while the modal is open with unsaved prompt text',
      should: 'preserve the in-progress prompt rather than clobbering it with the refetched value',
      actual: promptInput.value,
      expected: 'in-flight typing',
    });
  });
});
