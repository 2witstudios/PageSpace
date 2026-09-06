/**
 * The detection affordance against real hooks and stores: dark ⇒ nothing and
 * NO status fetch; no dev server ⇒ nothing; a recorded one ⇒ one quiet line
 * and a Preview button that opens the pane store — never auto-opens.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { SWRConfig } from 'swr';

const mockFetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
  post: vi.fn(),
}));

import { DevPreviewAffordance } from '../DevPreviewAffordance';
import { useDevPreviewPaneStore } from '@/stores/useDevPreviewPaneStore';
import type { DevPreviewStatusDTO } from '@/hooks/dev-preview/useDevPreviewStatus';

const STATUS_PATH = '/api/agent-workspaces/ws1/preview';

function status(over: Partial<DevPreviewStatusDTO> = {}): DevPreviewStatusDTO {
  return {
    holder: { kind: 'workspace', id: 'ws1' },
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

function renderAffordance(props: Partial<{ canManage: boolean }> = {}) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <DevPreviewAffordance statusPath={STATUS_PATH} title="My session" canManage={props.canManage ?? true} />
    </SWRConfig>,
  );
}

beforeEach(() => {
  capabilityEnabled = true;
  preview = status();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ enabled: capabilityEnabled }) })));
  mockFetchWithAuth.mockImplementation(async () => ({ ok: true, json: async () => ({ preview }) }));
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
    expect(mockFetchWithAuth).not.toHaveBeenCalled();
  });

  test('no dev server recorded: renders nothing (unobtrusive means absent)', async () => {
    preview = status({ state: { status: 'none', message: 'No dev server has been detected in this sandbox yet.' }, canOpen: false, canStop: false });
    const { container } = renderAffordance();
    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalledWith(STATUS_PATH));
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
  });

  test('a detected dev server: one line naming the port, a Preview button, and NOTHING opens until it is clicked', async () => {
    renderAffordance();
    await screen.findByText('Dev server detected on :5173');
    expect(useDevPreviewPaneStore.getState().open).toBeNull();
    const button = screen.getByRole('button', { name: 'Preview' });
    fireEvent.click(button);
    expect(useDevPreviewPaneStore.getState().open).toEqual({
      holder: { kind: 'workspace', id: 'ws1' },
      statusPath: STATUS_PATH,
      actionsPath: `${STATUS_PATH}/actions`,
      openPath: '/api/agent-workspaces/ws1/preview/open',
      title: 'My session',
      canManage: true,
    });
    // Once open, the button reads as such and is inert.
    await screen.findByRole('button', { name: 'Previewing' });
    expect(screen.getByRole('button', { name: 'Previewing' })).toBeDisabled();
  });

  test('a stopped or blocked preview still gets its honest line (last-known state, never hidden)', async () => {
    preview = status({ canOpen: false, canStop: false, canResume: true, state: { status: 'stopped', targetPort: 3000, stoppedAt: 'x', message: 'Preview of port 3000 is switched off.' } });
    renderAffordance();
    await screen.findByText('Preview of :3000 is switched off');
    expect(screen.getByText('Preview of :3000 is switched off')).toHaveAttribute('title', 'Preview of port 3000 is switched off.');
  });

  test('carries the reader\'s manage flag into the pane store', async () => {
    renderAffordance({ canManage: false });
    fireEvent.click(await screen.findByRole('button', { name: 'Preview' }));
    expect(useDevPreviewPaneStore.getState().open?.canManage).toBe(false);
  });
});
