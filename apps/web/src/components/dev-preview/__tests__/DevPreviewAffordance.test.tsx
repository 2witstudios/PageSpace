/**
 * The detection affordance against real hooks and stores: dark ⇒ nothing and
 * NO status fetch; no dev server ⇒ nothing; a recorded one ⇒ one quiet line
 * and a Preview button that opens the pane store — never auto-opens. The
 * manage verdict is the SERVER's, the verb is honest, and the poll respects
 * the caller's disclosure.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { SWRConfig } from 'swr';

const mockFetchJSON = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/auth-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/auth-fetch')>();
  return { ...actual, fetchJSON: (...args: unknown[]) => mockFetchJSON(...args), post: vi.fn() };
});

import { DevPreviewAffordance } from '../DevPreviewAffordance';
import { useDevPreviewPaneStore } from '@/stores/useDevPreviewPaneStore';
import type { DevPreviewStatusDTO } from '@/hooks/dev-preview/useDevPreviewStatus';

const STATUS_PATH = '/api/agent-workspaces/ws1/preview';

function status(over: Partial<DevPreviewStatusDTO> = {}): DevPreviewStatusDTO {
  return {
    holder: { kind: 'workspace', id: 'ws1' },
    canManage: true,
    sandbox: 'attached',
    state: { status: 'live', targetPort: 5173, via: 'relay', message: 'Relaying port 8080 to your dev server on port 5173.' },
    slot: { known: false },
    openPath: '/api/agent-workspaces/ws1/preview/open',
    canOpen: true,
    canStop: true,
    canResume: false,
    detectedAt: '2026-09-06T11:00:00.000Z',
    ...over,
  };
}

let capabilityEnabled = true;
let preview: DevPreviewStatusDTO = status();

function renderAffordance(props: Partial<{ active: boolean }> = {}) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <DevPreviewAffordance statusPath={STATUS_PATH} driveId="d1" title="My session" active={props.active} />
    </SWRConfig>,
  );
}

beforeEach(() => {
  capabilityEnabled = true;
  preview = status();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ enabled: capabilityEnabled }) })));
  mockFetchJSON.mockImplementation(async () => ({ preview }));
  useDevPreviewPaneStore.setState({ open: null, reloadNonce: 0 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('DevPreviewAffordance', () => {
  test('dark deployment: renders nothing and never calls the status route', async () => {
    capabilityEnabled = false;
    const { container } = renderAffordance();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/dev-preview/capability'));
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
    expect(mockFetchJSON).not.toHaveBeenCalled();
  });

  test('no dev server recorded: renders nothing (unobtrusive means absent)', async () => {
    preview = status({ state: { status: 'none', message: 'No dev server has been detected in this sandbox yet.' }, canOpen: false, canStop: false });
    const { container } = renderAffordance();
    await waitFor(() => expect(mockFetchJSON).toHaveBeenCalledWith(STATUS_PATH));
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
  });

  test('a detected dev server: one line naming the port, a Preview button, and NOTHING opens until it is clicked', async () => {
    renderAffordance();
    await screen.findByText('Dev server detected on :5173');
    expect(useDevPreviewPaneStore.getState().open).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(useDevPreviewPaneStore.getState().open).toEqual({
      holder: { kind: 'workspace', id: 'ws1' },
      driveId: 'd1',
      statusPath: STATUS_PATH,
      openPath: '/api/agent-workspaces/ws1/preview/open',
      title: 'My session',
    });
    // Once open, the button reads as such and is inert.
    await screen.findByRole('button', { name: 'Open' });
    expect(screen.getByRole('button', { name: 'Open' })).toBeDisabled();
  });

  test('a stopped or blocked preview still gets its honest line (last-known state, never hidden) — and the verb is "Details", not "Preview"', async () => {
    preview = status({ canOpen: false, canStop: false, canResume: true, state: { status: 'stopped', targetPort: 3000, stoppedAt: 'x', message: 'Preview of port 3000 is switched off.' } });
    renderAffordance();
    await screen.findByText('Preview of :3000 is switched off');
    expect(screen.getByText('Preview of :3000 is switched off')).toHaveAttribute('title', 'Preview of port 3000 is switched off.');
    expect(screen.getByRole('button', { name: 'Details' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull();
  });

  test('an unknown status renders neutral copy and "Details" rather than crashing the row', async () => {
    preview = status({ canOpen: false, state: { status: 'teleporting', message: 'from the future' } as unknown as DevPreviewStatusDTO['state'] });
    renderAffordance();
    await screen.findByText('Preview state unknown');
    expect(screen.getByRole('button', { name: 'Details' })).toBeInTheDocument();
  });

  test('polls only while ACTIVE — proved across a FULL poll interval, so wiring `active` as always-on would fail this', async () => {
    // The affordance polls on a 15s interval; a 60ms wall-clock wait would
    // pass even if `active` were ignored. Fake timers advance past three
    // intervals, and the ACTIVE case is the positive control that proves the
    // advance actually drives SWR.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const collapsed = renderAffordance({ active: false });
      await vi.waitFor(() => expect(mockFetchJSON).toHaveBeenCalledTimes(1));
      await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
      expect(mockFetchJSON).toHaveBeenCalledTimes(1);
      collapsed.unmount();

      mockFetchJSON.mockClear();
      renderAffordance({ active: true });
      await vi.waitFor(() => expect(mockFetchJSON).toHaveBeenCalledTimes(1));
      await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
      expect(mockFetchJSON.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
