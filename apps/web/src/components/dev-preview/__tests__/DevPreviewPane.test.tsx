/**
 * The preview pane against real hooks and real stores (an isolated SWR cache,
 * the real zustand pane store, the real editing store) — the only things
 * stubbed are the network edges: the capability fetch and the authenticated
 * status/actions fetches.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { SWRConfig } from 'swr';

// `fetchJSON` is what the status hook uses; it throws the REAL
// `ApiRequestError` on a non-2xx (the plain authenticated fetch never
// throws), which is what the pane's self-close `instanceof` check needs.
const mockFetchJSON = vi.hoisted(() => vi.fn());
const mockPost = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/auth-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/auth-fetch')>();
  return {
    ...actual,
    fetchJSON: (...args: unknown[]) => mockFetchJSON(...args),
    post: (...args: unknown[]) => mockPost(...args),
  };
});
const mockToastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => mockToastError(...args), success: vi.fn() } }));

import { DEV_PREVIEW_FRAME_SANDBOX, DevPreviewPane, buildFrameSrc } from '../DevPreviewPane';
import { ApiRequestError } from '@/lib/auth/auth-fetch';
import { useDevPreviewPaneStore, type OpenDevPreview } from '@/stores/useDevPreviewPaneStore';
import { useEditingStore } from '@/stores/useEditingStore';
import type { DevPreviewStatusDTO } from '@/hooks/dev-preview/useDevPreviewStatus';

const OPEN: OpenDevPreview = {
  holder: { kind: 'env', id: 'env1' },
  driveId: 'd1',
  statusPath: '/api/drives/d1/envs/env1/preview',
  openPath: '/api/drives/d1/envs/env1/preview/open',
  title: 'main',
};
const ACTIONS_PATH = '/api/drives/d1/envs/env1/preview/actions';

function live(over: Partial<DevPreviewStatusDTO> = {}): DevPreviewStatusDTO {
  return {
    holder: OPEN.holder,
    canManage: true,
    sandbox: 'attached',
    detection: 'watching',
    state: { status: 'live', targetPort: 5173, via: 'relay', message: 'Relaying port 8080 to your dev server on port 5173.' },
    slot: { known: true, holder: 'relay', pid: null, message: 'Port 8080 is held by the preview relay, forwarding to your dev server on port 5173.' },
    openPath: OPEN.openPath,
    canOpen: true,
    canStop: true,
    canResume: false,
    canApprove: false,
    spriteInstanceId: null,
    detectedAt: '2026-09-06T11:00:00.000Z',
    ...over,
  };
}

let capabilityEnabled = true;
let status: DevPreviewStatusDTO = live();

function renderPane(driveId: string | null = 'd1') {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <DevPreviewPane driveId={driveId} />
    </SWRConfig>,
  );
}

beforeEach(() => {
  capabilityEnabled = true;
  status = live();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ enabled: capabilityEnabled }) })));
  mockFetchJSON.mockImplementation(async () => ({ preview: status }));
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
        <DevPreviewPane driveId="d1" />
      </SWRConfig>,
    );
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByTestId('dev-preview-pane')).toBeNull();
    // Dark ⇒ the status route is never even called.
    expect(mockFetchJSON).not.toHaveBeenCalled();
  });

  test('a live preview: the frame loads the app-origin /preview/open route, the new-tab link targets the same route top-level, the badge is honest', async () => {
    act(() => useDevPreviewPaneStore.getState().openPreview(OPEN));
    renderPane();
    const frame = await screen.findByTestId('dev-preview-frame');
    expect(frame).toHaveAttribute('src', OPEN.openPath);
    expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
    // The allow-list: what a dev server needs, and nothing that reaches the PageSpace tab.
    expect(frame).toHaveAttribute('sandbox', DEV_PREVIEW_FRAME_SANDBOX);
    for (const granted of ['allow-scripts', 'allow-same-origin', 'allow-forms', 'allow-popups', 'allow-modals']) expect(DEV_PREVIEW_FRAME_SANDBOX.split(' ')).toContain(granted);
    for (const withheld of ['allow-top-navigation', 'allow-top-navigation-by-user-activation', 'allow-downloads', 'allow-popups-to-escape-sandbox']) expect(DEV_PREVIEW_FRAME_SANDBOX.split(' ')).not.toContain(withheld);
    const newTab = screen.getByTitle('Open the preview in a new tab');
    expect(newTab).toHaveAttribute('href', OPEN.openPath);
    expect(newTab).toHaveAttribute('target', '_blank');
    expect(newTab.getAttribute('rel')).toContain('noopener');
    expect(screen.getByText('Live · :5173')).toBeInTheDocument();
    // A live relay with a relay-held slot needs no extra line — the badge says it all.
    expect(screen.queryByTestId('dev-preview-status-line')).toBeNull();
    expect(mockFetchJSON).toHaveBeenCalledWith(OPEN.statusPath);
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
      slot: { known: true, holder: 'user-process', pid: 999, message: 'Port 8080 is held by another process in the sandbox (pid 999). Stop that process so the preview relay can bind 8080, or run your dev server on port 8080 directly.' },
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
    const before = mockFetchJSON.mock.calls.length;
    // The server will answer "stopped" to the re-read the action triggers.
    status = live({ canOpen: false, canStop: false, canResume: true, state: { status: 'stopped', targetPort: 5173, stoppedAt: '2026-09-06T12:00:00.000Z', message: 'Preview of port 5173 is switched off.' } });
    fireEvent.click(screen.getByTitle('Switch the preview off'));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(ACTIONS_PATH, { action: 'stop' }));
    await waitFor(() => expect(mockFetchJSON.mock.calls.length).toBeGreaterThan(before));
    await screen.findByTitle('Switch the preview back on');
    expect(screen.queryByTitle('Switch the preview off')).toBeNull();
    // The frame was shown for this open, so it STAYS mounted; the status line explains, once.
    expect(screen.getByTestId('dev-preview-frame')).toBeInTheDocument();
    expect(screen.queryByTestId('dev-preview-placeholder')).toBeNull();
    expect(screen.getByTestId('dev-preview-status-line')).toHaveTextContent('Preview of port 5173 is switched off.');
    expect(screen.getAllByText('Preview of port 5173 is switched off.')).toHaveLength(1);
    fireEvent.click(screen.getByTitle('Switch the preview back on'));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(ACTIONS_PATH, { action: 'resume' }));

    // The manage verdict is read LIVE from the status, never snapshotted at open.
    status = live({ canManage: false });
    fireEvent.click(screen.getByTitle('Reload the preview'));
    await waitFor(() => expect(screen.queryByTitle('Switch the preview back on')).toBeNull());
    expect(screen.queryByTitle('Switch the preview off')).toBeNull();
  });

  test('NEEDS APPROVAL: no frame, the audience is stated, and Share posts the PORT that was shown', async () => {
    status = live({
      canOpen: false,
      canStop: true,
      canResume: false,
      canApprove: true,
      spriteInstanceId: 'inst-live',
      state: { status: 'needs-approval', targetPort: 9000, message: 'A dev server is running on port 9000. It is not a usual dev-server port, so it is not being shared until you say so.' },
    });
    act(() => useDevPreviewPaneStore.getState().openPreview(OPEN));
    renderPane();
    // Nothing is served, so nothing is framed — the pane must not imply it is.
    await screen.findByTestId('dev-preview-placeholder');
    expect(screen.queryByTestId('dev-preview-frame')).toBeNull();
    expect(screen.getByText('Needs your OK · :9000')).toBeInTheDocument();
    // "Share" is meaningless without saying with whom.
    expect(screen.getByText('Everyone with access to this drive will be able to open it.')).toBeInTheDocument();
    // Stop is honest here: nothing is running to switch off.
    expect(screen.getByTitle('Dismiss this preview')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Share port 9000'));
    // The instance travels with the port: both are echoed from what was rendered.
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(ACTIONS_PATH, { action: 'approve', port: 9000, spriteInstanceId: 'inst-live' }));
  });

  test('a viewer who may not manage is offered NO way to share, however unshared the preview is', async () => {
    status = live({ canManage: false, canOpen: false, canApprove: true, state: { status: 'needs-approval', targetPort: 9000, message: 'not shared' } });
    act(() => useDevPreviewPaneStore.getState().openPreview(OPEN));
    renderPane();
    await screen.findByTestId('dev-preview-placeholder');
    expect(screen.queryByTitle('Share port 9000')).toBeNull();
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

  test('RE-AUTH: a reauth-required message FROM OUR FRAME about THIS holder re-points the frame through /preview/open; other sources, holders and shapes are ignored; repeats are debounced', async () => {
    act(() => useDevPreviewPaneStore.getState().openPreview(OPEN));
    renderPane();
    const frame = (await screen.findByTestId('dev-preview-frame')) as HTMLIFrameElement;
    expect(frame).toHaveAttribute('src', OPEN.openPath);
    const source = frame.contentWindow;
    expect(source).not.toBeNull();
    const reauth = { type: 'pagespace:dev-preview', event: 'reauth-required', holder: { kind: 'env', id: 'env1' } };

    // Wrong source (no source, the page itself), wrong holder, wrong shape.
    act(() => { window.dispatchEvent(new MessageEvent('message', { data: reauth })); });
    act(() => { window.dispatchEvent(new MessageEvent('message', { data: reauth, source: window })); });
    act(() => { window.dispatchEvent(new MessageEvent('message', { data: { ...reauth, holder: { kind: 'env', id: 'other' } }, source })); });
    act(() => { window.dispatchEvent(new MessageEvent('message', { data: { ...reauth, event: 'something-else' }, source })); });
    act(() => { window.dispatchEvent(new MessageEvent('message', { data: 'not an object', source })); });
    expect(screen.getByTestId('dev-preview-frame')).toHaveAttribute('src', OPEN.openPath);

    // The real thing, from our frame: one re-mint...
    act(() => { window.dispatchEvent(new MessageEvent('message', { data: reauth, source })); });
    await waitFor(() => expect(screen.getByTestId('dev-preview-frame')).toHaveAttribute('src', `${OPEN.openPath}?r=1`));
    // ...and a spam of repeats within the debounce window mints nothing more (each accepted one is a grant row).
    const again = (screen.getByTestId('dev-preview-frame') as HTMLIFrameElement).contentWindow;
    for (let i = 0; i < 5; i += 1) act(() => { window.dispatchEvent(new MessageEvent('message', { data: reauth, source: again })); });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByTestId('dev-preview-frame')).toHaveAttribute('src', `${OPEN.openPath}?r=1`);

    // The user's own Reload is never debounced.
    fireEvent.click(screen.getByTitle('Reload the preview'));
    await waitFor(() => expect(screen.getByTestId('dev-preview-frame')).toHaveAttribute('src', `${OPEN.openPath}?r=2`));
  });

  test('a transient non-live answer (dev server restarting) keeps the frame MOUNTED and explains above it; a preview never openable shows only the placeholder', async () => {
    act(() => useDevPreviewPaneStore.getState().openPreview(OPEN));
    renderPane();
    await screen.findByTestId('dev-preview-frame');
    status = live({ canOpen: false, state: { status: 'down', targetPort: 5173, via: 'relay', error: null, repairable: false, message: 'The dev server on port 5173 is not listening any more.' } });
    fireEvent.click(screen.getByTitle('Reload the preview'));
    await screen.findByText('Down · :5173');
    expect(screen.getByTestId('dev-preview-frame')).toBeInTheDocument();
    expect(screen.queryByTestId('dev-preview-placeholder')).toBeNull();
    expect(screen.getByTestId('dev-preview-status-line')).toHaveTextContent('not listening any more');
    // Said once: the placeholder is not also rendered.
    expect(screen.getAllByText(/not listening any more/)).toHaveLength(1);

    // A fresh open that was never openable: placeholder only, no frame.
    act(() => useDevPreviewPaneStore.getState().openPreview({ ...OPEN, statusPath: '/api/drives/d1/envs/env2/preview', holder: { kind: 'env', id: 'env2' } }));
    await screen.findByTestId('dev-preview-placeholder');
    expect(screen.queryByTestId('dev-preview-frame')).toBeNull();
  });

  test('closes itself when the status read answers 404/403 (holder gone or no longer ours); other errors keep the last answer', async () => {
    act(() => useDevPreviewPaneStore.getState().openPreview(OPEN));
    renderPane();
    await screen.findByTestId('dev-preview-frame');
    mockFetchJSON.mockImplementation(async () => { throw new ApiRequestError('boom', 500, null); });
    fireEvent.click(screen.getByTitle('Reload the preview'));
    await new Promise((r) => setTimeout(r, 30));
    expect(useDevPreviewPaneStore.getState().open).not.toBeNull();
    mockFetchJSON.mockImplementation(async () => { throw new ApiRequestError('gone', 404, null); });
    fireEvent.click(screen.getByTitle('Reload the preview'));
    await waitFor(() => expect(useDevPreviewPaneStore.getState().open).toBeNull());
    expect(screen.queryByTestId('dev-preview-pane')).toBeNull();
  });

  test('belongs to the drive it was opened in: hidden (and unpolled) beside another drive\'s console, back when the user returns — the store keeps it', async () => {
    act(() => useDevPreviewPaneStore.getState().openPreview(OPEN));
    const { rerender } = renderPane('other-drive');
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('dev-preview-pane')).toBeNull();
    expect(mockFetchJSON).not.toHaveBeenCalled();
    expect(useDevPreviewPaneStore.getState().open).toEqual(OPEN);
    rerender(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <DevPreviewPane driveId="d1" />
      </SWRConfig>,
    );
    await screen.findByTestId('dev-preview-frame');
  });

  test('pure helper: the frame src builder', () => {
    expect(buildFrameSrc('/p', 0)).toBe('/p');
    expect(buildFrameSrc('/p', 3)).toBe('/p?r=3');
    expect(buildFrameSrc('/p?x=1', 3)).toBe('/p?x=1&r=3');
  });
});
