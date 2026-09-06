/**
 * The preview pane against real hooks and real stores (an isolated SWR cache,
 * the real zustand pane store, the real editing store) — the only things
 * stubbed are the network edges: the capability fetch and the authenticated
 * status/actions fetches.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { SWRConfig } from 'swr';

const mockFetchWithAuth = vi.hoisted(() => vi.fn());
const mockPost = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
  post: (...args: unknown[]) => mockPost(...args),
}));
const mockToastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => mockToastError(...args), success: vi.fn() } }));

import { DevPreviewPane, buildFrameSrc, isReauthMessageFor } from '../DevPreviewPane';
import { useDevPreviewPaneStore, type OpenDevPreview } from '@/stores/useDevPreviewPaneStore';
import { useEditingStore } from '@/stores/useEditingStore';
import type { DevPreviewStatusDTO } from '@/hooks/dev-preview/useDevPreviewStatus';

const OPEN: OpenDevPreview = {
  holder: { kind: 'env', id: 'env1' },
  statusPath: '/api/drives/d1/envs/env1/preview',
  actionsPath: '/api/drives/d1/envs/env1/preview/actions',
  openPath: '/api/drives/d1/envs/env1/preview/open',
  title: 'main',
  canManage: true,
};

function live(over: Partial<DevPreviewStatusDTO> = {}): DevPreviewStatusDTO {
  return {
    holder: OPEN.holder,
    sandbox: 'attached',
    state: { status: 'live', targetPort: 5173, via: 'relay', message: 'Relaying port 8080 to your dev server on port 5173.' },
    slot: { known: true, free: false, holder: 'relay', pid: null, message: 'Port 8080 is held by the preview relay, forwarding to your dev server on port 5173.' },
    openPath: OPEN.openPath,
    canOpen: true,
    canStop: true,
    canResume: false,
    detectedAt: '2026-09-06T11:00:00.000Z',
    ...over,
  };
}

let capabilityEnabled = true;
let status: DevPreviewStatusDTO = live();

function renderPane() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <DevPreviewPane />
    </SWRConfig>,
  );
}

beforeEach(() => {
  capabilityEnabled = true;
  status = live();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ enabled: capabilityEnabled }) })));
  mockFetchWithAuth.mockImplementation(async () => ({ ok: true, json: async () => ({ preview: status }) }));
  mockPost.mockResolvedValue({ ok: true, applied: { action: 'stop-relay' } });
  useDevPreviewPaneStore.setState({ open: null, reloadNonce: 0 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('DevPreviewPane', () => {
  test('renders nothing while nothing is open, and nothing on a dark deployment even with a preview open', async () => {
    const { container, rerender } = renderPane();
    expect(container).toBeEmptyDOMElement();

    capabilityEnabled = false;
    act(() => useDevPreviewPaneStore.getState().openPreview(OPEN));
    rerender(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <DevPreviewPane />
      </SWRConfig>,
    );
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByTestId('dev-preview-pane')).toBeNull();
    // Dark ⇒ the status route is never even called.
    expect(mockFetchWithAuth).not.toHaveBeenCalled();
  });

  test('a live preview: the frame loads the app-origin /preview/open route, the new-tab link targets the same route top-level, the badge is honest', async () => {
    act(() => useDevPreviewPaneStore.getState().openPreview(OPEN));
    renderPane();
    const frame = await screen.findByTestId('dev-preview-frame');
    expect(frame).toHaveAttribute('src', OPEN.openPath);
    expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(frame).not.toHaveAttribute('sandbox');
    const newTab = screen.getByTitle('Open the preview in a new tab');
    expect(newTab).toHaveAttribute('href', OPEN.openPath);
    expect(newTab).toHaveAttribute('target', '_blank');
    expect(newTab.getAttribute('rel')).toContain('noopener');
    expect(screen.getByText('Live · :5173')).toBeInTheDocument();
    // A live relay with a relay-held slot needs no extra line — the badge says it all.
    expect(screen.queryByTestId('dev-preview-status-line')).toBeNull();
    expect(mockFetchWithAuth).toHaveBeenCalledWith(OPEN.statusPath);
  });

  test('registers with the editing store while open and releases it on close', async () => {
    act(() => useDevPreviewPaneStore.getState().openPreview(OPEN));
    renderPane();
    await screen.findByTestId('dev-preview-frame');
    expect(useEditingStore.getState().activeSessions.has('dev-preview-pane-env-env1')).toBe(true);
    fireEvent.click(screen.getByTitle('Close the preview pane'));
    await waitFor(() => expect(screen.queryByTestId('dev-preview-pane')).toBeNull());
    expect(useEditingStore.getState().activeSessions.has('dev-preview-pane-env-env1')).toBe(false);
  });

  test('BLOCKED: no frame; the core busy message and the slot explanation (pid + how to release) are shown', async () => {
    status = live({
      canOpen: false,
      state: { status: 'blocked', targetPort: 5173, message: 'Port 8080 is already in use by something that is not the preview relay. Run your dev server on port 8080 to preview it, or free the port.' },
      slot: { known: true, free: false, holder: 'user-process', pid: 999, message: 'Port 8080 is held by another process in the sandbox (pid 999). Stop that process so the preview relay can bind 8080, or run your dev server on port 8080 directly.' },
    });
    act(() => useDevPreviewPaneStore.getState().openPreview(OPEN));
    renderPane();
    await screen.findByTestId('dev-preview-placeholder');
    expect(screen.queryByTestId('dev-preview-frame')).toBeNull();
    // Said ONCE (in the placeholder), never also in the status line.
    expect(screen.getAllByText(/Port 8080 is already in use by something that is not the preview relay/)).toHaveLength(1);
    expect(screen.getByText(/pid 999/)).toBeInTheDocument();
    expect(screen.getByText('Port 8080 in use')).toBeInTheDocument();
  });

  test('STOP posts the action to the actions path and re-reads; RESUME appears once the server says so; neither for a viewer who may not manage', async () => {
    act(() => useDevPreviewPaneStore.getState().openPreview(OPEN));
    renderPane();
    await screen.findByTestId('dev-preview-frame');
    const before = mockFetchWithAuth.mock.calls.length;
    // The server will answer "stopped" to the re-read the action triggers.
    status = live({ canOpen: false, canStop: false, canResume: true, state: { status: 'stopped', targetPort: 5173, stoppedAt: '2026-09-06T12:00:00.000Z', message: 'Preview of port 5173 is switched off.' } });
    fireEvent.click(screen.getByTitle('Switch the preview off'));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(OPEN.actionsPath, { action: 'stop' }));
    await waitFor(() => expect(mockFetchWithAuth.mock.calls.length).toBeGreaterThan(before));
    await screen.findByTitle('Switch the preview back on');
    expect(screen.queryByTestId('dev-preview-frame')).toBeNull();
    expect(screen.queryByTitle('Switch the preview off')).toBeNull();
    expect(screen.getByTestId('dev-preview-placeholder')).toHaveTextContent('Preview of port 5173 is switched off.');
    expect(screen.queryByTestId('dev-preview-status-line')).toBeNull();
    fireEvent.click(screen.getByTitle('Switch the preview back on'));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(OPEN.actionsPath, { action: 'resume' }));

    act(() => useDevPreviewPaneStore.getState().openPreview({ ...OPEN, canManage: false }));
    await screen.findByTestId('dev-preview-pane');
    expect(screen.queryByTitle('Switch the preview back on')).toBeNull();
    expect(screen.queryByTitle('Switch the preview off')).toBeNull();
  });

  test('STARTING: the frame is up AND the status line explains the relay is coming up (the one time both show)', async () => {
    status = live({ state: { status: 'starting', targetPort: 5173, via: 'relay', message: 'Starting the preview relay for port 5173…' } });
    act(() => useDevPreviewPaneStore.getState().openPreview(OPEN));
    renderPane();
    await screen.findByTestId('dev-preview-frame');
    expect(screen.getByTestId('dev-preview-status-line')).toHaveTextContent('Starting the preview relay for port 5173…');
    expect(screen.getByText('Starting · :5173')).toBeInTheDocument();
  });

  test('a failed action toasts and still re-reads the status', async () => {
    mockPost.mockRejectedValueOnce(new Error('nope'));
    act(() => useDevPreviewPaneStore.getState().openPreview(OPEN));
    renderPane();
    await screen.findByTestId('dev-preview-frame');
    fireEvent.click(screen.getByTitle('Switch the preview off'));
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('Could not switch the preview off', expect.objectContaining({ description: 'nope' })));
  });

  test('RE-AUTH: a reauth-required message about THIS holder re-points the frame through /preview/open; other holders and other shapes are ignored', async () => {
    act(() => useDevPreviewPaneStore.getState().openPreview(OPEN));
    renderPane();
    const frame = await screen.findByTestId('dev-preview-frame');
    expect(frame).toHaveAttribute('src', OPEN.openPath);

    act(() => { window.dispatchEvent(new MessageEvent('message', { data: { type: 'pagespace:dev-preview', event: 'reauth-required', holder: { kind: 'env', id: 'other' } } })); });
    act(() => { window.dispatchEvent(new MessageEvent('message', { data: { type: 'pagespace:dev-preview', event: 'something-else', holder: OPEN.holder } })); });
    act(() => { window.dispatchEvent(new MessageEvent('message', { data: 'not an object' })); });
    expect(screen.getByTestId('dev-preview-frame')).toHaveAttribute('src', OPEN.openPath);

    act(() => { window.dispatchEvent(new MessageEvent('message', { data: { type: 'pagespace:dev-preview', event: 'reauth-required', holder: { kind: 'env', id: 'env1' } } })); });
    await waitFor(() => expect(screen.getByTestId('dev-preview-frame')).toHaveAttribute('src', `${OPEN.openPath}?r=1`));

    fireEvent.click(screen.getByTitle('Reload the preview'));
    await waitFor(() => expect(screen.getByTestId('dev-preview-frame')).toHaveAttribute('src', `${OPEN.openPath}?r=2`));
  });

  test('pure helpers: the reauth shape check and the frame src builder', () => {
    expect(isReauthMessageFor({ type: 'pagespace:dev-preview', event: 'reauth-required', holder: { kind: 'workspace', id: 'w' } }, { kind: 'workspace', id: 'w' })).toBe(true);
    expect(isReauthMessageFor({ type: 'pagespace:dev-preview', event: 'reauth-required', holder: { kind: 'env', id: 'w' } }, { kind: 'workspace', id: 'w' })).toBe(false);
    expect(isReauthMessageFor({ type: 'pagespace:dev-preview', event: 'reauth-required', holder: null }, { kind: 'workspace', id: 'w' })).toBe(false);
    expect(isReauthMessageFor(null, { kind: 'workspace', id: 'w' })).toBe(false);
    expect(buildFrameSrc('/p', 0)).toBe('/p');
    expect(buildFrameSrc('/p', 3)).toBe('/p?r=3');
    expect(buildFrameSrc('/p?x=1', 3)).toBe('/p?x=1&r=3');
  });
});
