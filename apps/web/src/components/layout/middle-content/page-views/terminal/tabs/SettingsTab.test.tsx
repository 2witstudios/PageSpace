import { StrictMode } from 'react';
import { describe, test, beforeEach, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
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
  // resetAllMocks, NOT clearAllMocks: clear only wipes call history, leaving any
  // unconsumed `mockResolvedValueOnce` queued for the NEXT test. That order-couples
  // the suite and turns one real failure into a misleading cascade.
  beforeEach(() => vi.resetAllMocks());

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

  test('blurring a field the user never edited sends no PATCH', async () => {
    mockLoad();
    render(<SettingsTab machineId="m1" />);

    const name = await screen.findByLabelText('Name');
    await userEvent.click(name);
    await userEvent.tab(); // focus + blur, no edit
    await userEvent.click(screen.getByLabelText('Description'));
    await userEvent.tab();

    assert({
      given: 'both text fields focused and blurred without an edit',
      should: 'send no PATCH — an unchanged value is not a save',
      actual: apiPatch.mock.calls.length,
      expected: 0,
    });
  });

  test('a name is trimmed before it is persisted and before it is displayed', async () => {
    mockLoad();
    apiPatch.mockResolvedValue({ settings: baseSettings });
    render(<SettingsTab machineId="m1" />);

    const name = (await screen.findByLabelText('Name')) as HTMLInputElement;
    await userEvent.clear(name);
    await userEvent.type(name, '  Padded  ');
    await userEvent.tab();

    await waitFor(() => assert({
      given: 'a name typed with surrounding whitespace',
      should: 'PATCH the trimmed name and settle the input on it — the client must normalize exactly as the route does, which is what licenses not reconciling from the response',
      actual: { patched: apiPatch.mock.calls[0]?.[1], displayed: name.value },
      expected: { patched: { machineId: 'm1', name: 'Padded' }, displayed: 'Padded' },
    }));
  });

  test('a resync adopts server values for untouched fields but never clobbers a dirty draft', async () => {
    // The failed toggle triggers a resync GET. That GET must not delete text the
    // user is in the middle of typing — but it SHOULD pick up the server's value
    // for a field they haven't touched.
    const serverMoved: MachineSettings = { ...baseSettings, description: 'changed elsewhere' };
    fetchWithAuth
      .mockResolvedValueOnce({ ok: true, json: async () => ({ settings: baseSettings }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ settings: serverMoved }) });
    let failToggle: (e: Error) => void = () => {};
    apiPatch.mockImplementation(() => new Promise((_r, reject) => { failToggle = reject; }));
    render(<SettingsTab machineId="m1" />);

    await userEvent.click(await screen.findByRole('switch', { name: /allow page agents/i }));

    // Type into Name WITHOUT blurring — this draft is dirty and uncommitted.
    const name = (await screen.findByLabelText('Name')) as HTMLInputElement;
    await userEvent.clear(name);
    await userEvent.type(name, 'Half-typed');

    failToggle(new Error('boom')); // -> revert + resync GET

    await waitFor(() => assert({
      given: 'a resync landing while the user is mid-edit in Name',
      should: "keep the dirty Name draft and adopt the server's Description (untouched)",
      actual: {
        name: (screen.getByLabelText('Name') as HTMLInputElement).value,
        description: (screen.getByLabelText('Description') as HTMLTextAreaElement).value,
      },
      expected: { name: 'Half-typed', description: 'changed elsewhere' },
    }));
  });

  test('escaping a hung delete leaves a usable dialog, not a stuck "Deleting…" button', async () => {
    mockLoad();
    apiDelete.mockImplementation(() => new Promise(() => {})); // never settles
    render(<SettingsTab machineId="m1" />);

    await screen.findByLabelText('Name');
    await userEvent.click(screen.getByRole('button', { name: /delete machine/i }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /delete machine/i }));
    await screen.findByRole('button', { name: /deleting/i }); // request is in flight

    // The DELETE is held open behind preventDefault, so Escape is the only exit.
    // Closing must clear `deleting` or reopening shows a dead, disabled button.
    await userEvent.keyboard('{Escape}');
    await waitFor(() => assert({
      given: 'Escape pressed during a hung delete',
      should: 'close the dialog',
      actual: screen.queryByRole('alertdialog') === null,
      expected: true,
    }));

    await userEvent.click(screen.getByRole('button', { name: /delete machine/i }));
    const reopened = within(await screen.findByRole('alertdialog')).getByRole('button', { name: /delete machine/i }) as HTMLButtonElement;

    assert({
      given: 'the confirm dialog reopened after escaping a hung delete',
      should: 'offer an enabled "Delete Machine" button, not a stuck "Deleting…" one',
      actual: { label: reopened.textContent, disabled: reopened.disabled },
      expected: { label: 'Delete Machine', disabled: false },
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

  test('a failed save does not revert an unrelated edit that landed while it was in flight', async () => {
    mockLoad();
    // The toggle's PATCH hangs and then fails; the name's PATCH succeeds meanwhile.
    // Reverting a whole snapshot (rather than just the failed save's own keys)
    // would roll the successful rename back out of the UI.
    let failToggle: (e: Error) => void = () => {};
    apiPatch.mockImplementation((_url: string, body: Record<string, unknown>) => {
      if ('visibleToGlobalAssistant' in body) {
        return new Promise((_resolve, reject) => { failToggle = reject; });
      }
      return Promise.resolve({ settings: baseSettings });
    });
    render(<SettingsTab machineId="m1" />);

    await userEvent.click(await screen.findByRole('switch', { name: /visible to global assistant/i }));
    const name = (await screen.findByLabelText('Name')) as HTMLInputElement;
    await userEvent.clear(name);
    await userEvent.type(name, 'Renamed');
    await userEvent.tab();
    await waitFor(() => assert({
      given: 'the rename PATCH sent while the toggle PATCH is still in flight',
      should: 'have sent both',
      actual: apiPatch.mock.calls.length,
      expected: 2,
    }));

    failToggle(new Error('toggle failed'));

    await waitFor(() => assert({
      given: 'the toggle save failing after an unrelated rename succeeded',
      should: 'revert only the toggle, leaving the successful rename intact',
      actual: {
        toggle: screen.getByRole('switch', { name: /visible to global assistant/i }).getAttribute('aria-checked'),
        name: (screen.getByLabelText('Name') as HTMLInputElement).value,
      },
      expected: { toggle: 'false', name: 'Renamed' },
    }));
  });

  test('the resync GET waits for every in-flight save to drain', async () => {
    mockLoad();
    let failToggle: (e: Error) => void = () => {};
    let resolveName: (v: unknown) => void = () => {};
    apiPatch.mockImplementation((_url: string, body: Record<string, unknown>) => {
      if ('visibleToGlobalAssistant' in body) {
        return new Promise((_resolve, reject) => { failToggle = reject; });
      }
      return new Promise((resolve) => { resolveName = resolve; });
    });
    render(<SettingsTab machineId="m1" />);

    await userEvent.click(await screen.findByRole('switch', { name: /visible to global assistant/i }));
    const name = await screen.findByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Renamed');
    await userEvent.tab();
    await waitFor(() => assert({ given: 'two saves', should: 'both be sent', actual: apiPatch.mock.calls.length, expected: 2 }));

    // The toggle fails while the rename is STILL in flight. A GET fired now would
    // read pre-rename state and then be overwritten by the rename that lands after
    // it — stranding exactly the staleness the resync exists to fix.
    failToggle(new Error('toggle failed'));

    // Gate on the error toast, which proves the catch block ran and its effects
    // flushed. Asserting the fetch count under a bare waitFor would be vacuous:
    // waitFor polls until the assertion PASSES, so "still 1" would succeed on the
    // first poll — before an eager refetch had a chance to fire.
    await waitFor(() => assert({
      given: 'the toggle save rejecting',
      should: 'have surfaced the failure (its catch block has run)',
      actual: (toast.error as ReturnType<typeof vi.fn>).mock.calls.length,
      expected: 1,
    }));
    assert({
      given: 'a save that failed while another save is still airborne',
      should: 'NOT refetch yet — only the initial GET has been made',
      actual: fetchWithAuth.mock.calls.length,
      expected: 1,
    });

    resolveName({ settings: baseSettings });

    await waitFor(() => assert({
      given: 'the last in-flight save draining',
      should: 'now fire the deferred resync GET',
      actual: fetchWithAuth.mock.calls.length,
      expected: 2,
    }));
  });

  test('a failed delete keeps the dialog open and re-enables the confirm button', async () => {
    mockLoad();
    apiDelete.mockRejectedValue(new Error('sprite teardown exploded'));
    render(<SettingsTab machineId="m1" />);

    await screen.findByLabelText('Name');
    await userEvent.click(screen.getByRole('button', { name: /delete machine/i }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /delete machine/i }));

    await waitFor(() => assert({
      given: 'a DELETE that failed',
      should: 'keep the dialog open with a re-enabled confirm button, and not navigate',
      actual: {
        open: screen.queryByRole('alertdialog') !== null,
        disabled: (within(screen.getByRole('alertdialog')).getByRole('button', { name: /delete machine/i }) as HTMLButtonElement).disabled,
        navigated: push.mock.calls.length,
      },
      expected: { open: true, disabled: false, navigated: 0 },
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

  test('renders the form under StrictMode (no impure updater stranding the spinner)', async () => {
    // Next 15 enables reactStrictMode by default, so `bun run dev` always double-
    // invokes effects and REPLAYS state updaters at render time. An updater with a
    // side effect inside (e.g. calling setLoading from within a setSettings
    // updater) gets replayed after the load's `finally` already cleared loading —
    // stranding the tab on a spinner forever. This is the dev-only path, so only a
    // StrictMode render catches it.
    mockLoad();
    render(
      <StrictMode>
        <SettingsTab machineId="m1" />
      </StrictMode>,
    );

    const name = (await screen.findByLabelText('Name')) as HTMLInputElement;
    assert({
      given: 'the tab mounted under StrictMode with a successful load',
      should: 'render the loaded form, not hang on the spinner',
      actual: name.value,
      expected: 'My Machine',
    });
  });

  test('a save that settles after a machine switch never writes onto the new machine', async () => {
    const other: MachineSettings = { ...baseSettings, name: 'Other Machine', description: 'other' };
    fetchWithAuth.mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        json: async () => ({ settings: url.includes('m2') ? other : baseSettings }),
      }),
    );
    let failRename: (e: Error) => void = () => {};
    apiPatch.mockImplementation(() => new Promise((_r, reject) => { failRename = reject; }));

    const { rerender } = render(<SettingsTab machineId="m1" />);
    const name = await screen.findByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Renamed');
    await userEvent.tab(); // m1's rename PATCH is now in flight

    rerender(<SettingsTab machineId="m2" />);
    await waitFor(() => assert({
      given: 'a switch to m2',
      should: 'show m2 settings',
      actual: (screen.getByLabelText('Name') as HTMLInputElement).value,
      expected: 'Other Machine',
    }));

    // m1's rename now fails. Its revert must NOT write m1's old name into m2's
    // form — where the next blur would rename m2.
    failRename(new Error('too late'));

    // Flush the rejection and React's resulting work. This CANNOT be a `waitFor`:
    // when the guard works, the correct outcome is that nothing happens, so a
    // polling assertion would pass on its first tick before the rejection even
    // propagated — asserting nothing. Drain, then assert once.
    await act(async () => { await Promise.resolve(); });

    assert({
      given: "a stale machine's save failing after the tab moved to another machine",
      should: "leave the new machine's form untouched and stay silent",
      actual: {
        name: (screen.getByLabelText('Name') as HTMLInputElement).value,
        errored: (toast.error as ReturnType<typeof vi.fn>).mock.calls.length,
      },
      expected: { name: 'Other Machine', errored: 0 },
    });
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
