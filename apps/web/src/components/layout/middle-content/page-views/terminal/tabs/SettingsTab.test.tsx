import { describe, test, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { assert } from '@/stores/__tests__/riteway';
import type { MachineSettings } from '@pagespace/lib/services/machines/machine-settings';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  useParams: () => ({ driveId: 'drive-1' }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const fetchWithAuth = vi.fn();
const apiPatch = vi.fn();
const apiDelete = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
  patch: (...args: unknown[]) => apiPatch(...args),
  del: (...args: unknown[]) => apiDelete(...args),
}));

import SettingsTab from './SettingsTab';
import { toast } from 'sonner';

const baseSettings: MachineSettings = {
  name: 'My Machine',
  description: 'does things',
  visibleToGlobalAssistant: false,
  allowPageAgents: false,
};

function mockLoad(settings: MachineSettings = baseSettings) {
  fetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({ settings }) });
}

describe('SettingsTab', () => {
  beforeEach(() => vi.clearAllMocks());

  test('loads the machine settings into the form', async () => {
    mockLoad();
    render(<SettingsTab machineId="m1" />);

    const nameInput = (await screen.findByLabelText('Name')) as HTMLInputElement;
    const globalToggle = screen.getByRole('switch', { name: /visible to global assistant/i });

    assert({
      given: 'a Machine whose settings load successfully',
      should: 'GET the settings by machineId and populate the form from the response',
      actual: {
        url: fetchWithAuth.mock.calls[0][0],
        name: nameInput.value,
        visible: globalToggle.getAttribute('aria-checked'),
      },
      expected: {
        // The route reads machineId from the QUERY on GET (body only on PATCH) —
        // pin it, since that mismatch would 400 in prod but pass a lax mock.
        url: '/api/machines/settings?machineId=m1',
        name: 'My Machine',
        visible: 'false',
      },
    });
  });

  test('blanking the name reverts instead of firing a PATCH the route would reject', async () => {
    mockLoad();
    render(<SettingsTab machineId="m1" />);

    const name = (await screen.findByLabelText('Name')) as HTMLInputElement;
    await userEvent.clear(name);
    await userEvent.tab();

    assert({
      given: 'the name field blanked and blurred',
      should: 'revert to the server name and send no PATCH (an empty name is a 400)',
      actual: { value: name.value, patches: apiPatch.mock.calls.length },
      expected: { value: 'My Machine', patches: 0 },
    });
  });

  test('clearing the description persists null, not an empty string', async () => {
    mockLoad();
    apiPatch.mockResolvedValue({ settings: { ...baseSettings, description: null } });
    render(<SettingsTab machineId="m1" />);

    const description = await screen.findByLabelText('Description');
    await userEvent.clear(description);
    await userEvent.tab();

    await waitFor(() => assert({
      given: 'the description emptied and blurred',
      should: 'PATCH description:null — the route round-trips blank to null',
      actual: apiPatch.mock.calls[0]?.[1],
      expected: { machineId: 'm1', description: null },
    }));
  });

  test('toggling an access switch optimistically PATCHes only the flipped flag', async () => {
    mockLoad();
    apiPatch.mockResolvedValue({ settings: { ...baseSettings, visibleToGlobalAssistant: true } });
    render(<SettingsTab machineId="m1" />);

    const toggle = await screen.findByRole('switch', { name: /visible to global assistant/i });
    await userEvent.click(toggle);

    await waitFor(() => assert({
      given: 'the visible-to-global-assistant switch clicked',
      should: 'PATCH the settings route with the machineId and the flipped flag only',
      actual: apiPatch.mock.calls[0],
      expected: ['/api/machines/settings', { machineId: 'm1', visibleToGlobalAssistant: true }],
    }));

    await waitFor(() => assert({
      given: 'a successful PATCH response',
      should: 'leave the switch on and never toast an error',
      actual: { checked: toggle.getAttribute('aria-checked'), errored: (toast.error as ReturnType<typeof vi.fn>).mock.calls.length },
      expected: { checked: 'true', errored: 0 },
    }));
  });

  test('committing a text field by clicking a toggle does not swallow the toggle', async () => {
    mockLoad({ ...baseSettings, description: null });
    // A save that never settles: if an in-flight save disabled the controls, the
    // switch would already be disabled by the time the click's mouseup landed.
    apiPatch.mockImplementation(() => new Promise(() => {}));
    render(<SettingsTab machineId="m1" />);

    const name = await screen.findByLabelText('Name');
    await userEvent.type(name, '!');
    // Clicking the switch blurs the input, which commits the name mid-click.
    await userEvent.click(screen.getByRole('switch', { name: /visible to global assistant/i }));

    await waitFor(() => assert({
      given: 'a name edit committed on blur by the very click that hits a switch',
      should: 'still PATCH the toggle — an in-flight save must not disable the control being clicked',
      actual: apiPatch.mock.calls.map((call) => Object.keys(call[1] as object).filter((k) => k !== 'machineId')).flat(),
      expected: ['name', 'visibleToGlobalAssistant'],
    }));
  });

  test('a failed name save rolls the input back to the server value', async () => {
    mockLoad();
    apiPatch.mockRejectedValue(new Error('nope'));
    render(<SettingsTab machineId="m1" />);

    const name = (await screen.findByLabelText('Name')) as HTMLInputElement;
    await userEvent.clear(name);
    await userEvent.type(name, 'Renamed');
    await userEvent.tab();

    await waitFor(() => assert({
      given: 'a rejected name PATCH',
      should: 'restore the input to the last-known-good server name',
      actual: name.value,
      expected: 'My Machine',
    }));
  });

  test('a failed PATCH rolls the toggle back and surfaces an error toast', async () => {
    mockLoad();
    apiPatch.mockRejectedValue(new Error('nope'));
    render(<SettingsTab machineId="m1" />);

    const toggle = await screen.findByRole('switch', { name: /allow page agents/i });
    await userEvent.click(toggle);

    await waitFor(() => assert({
      given: 'the PATCH rejected',
      should: 'show an error toast',
      actual: (toast.error as ReturnType<typeof vi.fn>).mock.calls.length,
      expected: 1,
    }));

    await waitFor(() => assert({
      given: 'the optimistic update rolled back',
      should: 'restore the switch to its pre-click (off) state',
      actual: toggle.getAttribute('aria-checked'),
      expected: 'false',
    }));
  });

  test('a failed save resyncs from the server rather than trusting the local rollback', async () => {
    // The PATCH fails, but the server had ALREADY committed it (commit-then-timeout).
    // A pure client-side rollback would strand the tab showing the stale value with
    // nothing to revalidate it, so persist() must refetch.
    const committed: MachineSettings = { ...baseSettings, allowPageAgents: true };
    fetchWithAuth
      .mockResolvedValueOnce({ ok: true, json: async () => ({ settings: baseSettings }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ settings: committed }) });
    apiPatch.mockRejectedValue(new Error('timeout'));
    render(<SettingsTab machineId="m1" />);

    const toggle = await screen.findByRole('switch', { name: /allow page agents/i });
    await userEvent.click(toggle);

    await waitFor(() => assert({
      given: 'a PATCH that failed after the server committed it',
      should: 'refetch and converge on the true server state, not the guessed rollback',
      actual: { fetches: fetchWithAuth.mock.calls.length, checked: toggle.getAttribute('aria-checked') },
      expected: { fetches: 2, checked: 'true' },
    }));
  });

  test('switching machineId never renders the previous machine\'s settings', async () => {
    fetchWithAuth
      .mockResolvedValueOnce({ ok: true, json: async () => ({ settings: baseSettings }) })
      // The second machine fails to load — the first machine's settings must NOT
      // linger on screen under the new machine's identity.
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    const { rerender } = render(<SettingsTab machineId="m1" />);
    await screen.findByLabelText('Name');

    rerender(<SettingsTab machineId="m2" />);

    await waitFor(() => assert({
      given: 'a switch to a machine whose settings fail to load',
      should: 'show the error state, not the previous machine\'s stale form',
      actual: {
        staleForm: screen.queryByLabelText('Name') !== null,
        errored: screen.queryByRole('button', { name: /retry/i }) !== null,
      },
      expected: { staleForm: false, errored: true },
    }));
  });

  test('a first-load failure shows the error state and Retry refetches', async () => {
    fetchWithAuth
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ settings: baseSettings }) });
    render(<SettingsTab machineId="m1" />);

    const retry = await screen.findByRole('button', { name: /retry/i });
    await userEvent.click(retry);

    const name = (await screen.findByLabelText('Name')) as HTMLInputElement;
    assert({
      given: 'the initial GET failing and then Retry clicked',
      should: 'refetch and render the form once the settings load',
      actual: name.value,
      expected: 'My Machine',
    });
  });

  test('Delete Machine is gated behind the confirm dialog', async () => {
    mockLoad();
    apiDelete.mockResolvedValue({ success: true, spriteTornDown: true });
    render(<SettingsTab machineId="m1" />);

    // Wait for load, then open the confirm dialog via the trigger.
    await screen.findByLabelText('Name');
    const trigger = screen.getByRole('button', { name: /delete machine/i });
    await userEvent.click(trigger);

    assert({
      given: 'the delete trigger clicked (dialog opened, not confirmed)',
      should: 'NOT call the DELETE route yet',
      actual: apiDelete.mock.calls.length,
      expected: 0,
    });

    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /delete machine/i }));

    await waitFor(() => assert({
      given: 'the confirm action clicked',
      should: 'DELETE the machine by id',
      actual: apiDelete.mock.calls[0],
      expected: ['/api/machines/settings?machineId=m1'],
    }));

    await waitFor(() => assert({
      given: 'a successful delete',
      should: 'navigate back to the drive, off the trashed page',
      actual: push.mock.calls[0],
      expected: ['/dashboard/drive-1'],
    }));
  });
});
