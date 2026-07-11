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
      should: 'populate the name field and reflect the access toggle state',
      actual: { name: nameInput.value, visible: globalToggle.getAttribute('aria-checked') },
      expected: { name: 'My Machine', visible: 'false' },
    });
  });

  test('toggling an access switch optimistically PATCHes and reconciles with the server', async () => {
    mockLoad();
    apiPatch.mockResolvedValue({ settings: { ...baseSettings, visibleToGlobalAssistant: true } });
    render(<SettingsTab machineId="m1" />);

    const toggle = await screen.findByRole('switch', { name: /visible to global assistant/i });
    await userEvent.click(toggle);

    await waitFor(() => assert({
      given: 'the visible-to-global-assistant switch clicked',
      should: 'PATCH the settings route with the machineId and the flipped flag',
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
