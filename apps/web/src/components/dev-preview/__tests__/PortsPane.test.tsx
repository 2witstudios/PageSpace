/**
 * THE preview surface against real hooks and the real editing store — the only
 * things stubbed are the network edges (the capability fetch, the
 * authenticated status/actions/ports fetches) and sonner.
 *
 * It NEVER probes on mount (a persisted, multi-viewer pane must not bill a
 * wake per reload); the list appears only behind the header's Ports control;
 * a pick echoes the listing's instance and folds the list away; the frame,
 * once armed, survives a transient non-live answer; the chrome that governs
 * the preview — stop/resume, share, re-auth, open in a new tab — lives here,
 * because this is the one surface (there is no side panel).
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { SWRConfig } from 'swr';

const mockFetchJSON = vi.hoisted(() => vi.fn());
const mockPost = vi.hoisted(() => vi.fn());
const mockToastError = vi.hoisted(() => vi.fn());
const mockToastInfo = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => mockToastError(...args), info: (...args: unknown[]) => mockToastInfo(...args), success: vi.fn() } }));
vi.mock('@/lib/auth/auth-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/auth-fetch')>();
  return { ...actual, fetchJSON: (...args: unknown[]) => mockFetchJSON(...args), post: (...args: unknown[]) => mockPost(...args) };
});

import { PortsPane } from '../PortsPane';
import { useEditingStore } from '@/stores/useEditingStore';
import type { DevPreviewStatusDTO } from '@/hooks/dev-preview/useDevPreviewStatus';

const STATUS_PATH = '/api/agent-workspaces/ws1/preview';
const PORTS_PATH = `${STATUS_PATH}/ports`;
const ACTIONS_PATH = `${STATUS_PATH}/actions`;

function status(over: Partial<DevPreviewStatusDTO> = {}): DevPreviewStatusDTO {
  return {
    holder: { kind: 'workspace', id: 'ws1' },
    canManage: true,
    sandbox: 'attached',
    detection: 'watching',
    state: { status: 'none', message: 'No dev server has been detected in this sandbox yet.' },
    slot: { known: false },
    openPath: null,
    canOpen: false,
    canStop: false,
    canResume: false,
    canApprove: false,
    spriteInstanceId: 'inst-live',
    detectedAt: null,
    ...over,
  } as DevPreviewStatusDTO;
}

const LISTING = {
  spriteInstanceId: 'inst-live',
  currentPort: null,
  ports: [
    { port: 3000, pid: 2311, kind: 'dev-server', likelihood: 'known-dev-port', current: false },
    { port: 5432, pid: 9, kind: 'ignored', reason: 'non-http-service-port', current: false },
  ],
};

let capabilityEnabled = true;
let preview = status();

function renderPane() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PortsPane workspaceId="ws1" />
    </SWRConfig>,
  );
}

beforeEach(() => {
  capabilityEnabled = true;
  preview = status();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ enabled: capabilityEnabled }) })));
  mockFetchJSON.mockImplementation(async () => ({ preview }));
  mockPost.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('PortsPane', () => {
  test('NEVER probes on mount — the status is read, the ports route is not', async () => {
    renderPane();
    await waitFor(() => expect(mockFetchJSON).toHaveBeenCalledWith(STATUS_PATH));
    await new Promise((r) => setTimeout(r, 30));
    expect(mockPost).not.toHaveBeenCalled();
    expect(screen.getByTestId('ports-scan')).toBeInTheDocument();
  });

  test('Scan is held until the status loads, and disabled when the SERVER says this viewer cannot manage the preview', async () => {
    // Listing is the first half of exposing; the route answers 403 to a
    // non-manager. Enabling the button anyway would refuse every click.
    preview = status({ canManage: false });
    renderPane();
    await waitFor(() => expect(mockFetchJSON).toHaveBeenCalledWith(STATUS_PATH));
    await waitFor(() => expect(screen.getByTestId('ports-scan')).toBeDisabled());
    expect(screen.getByTestId('ports-scan')).toHaveAttribute('title', expect.stringContaining('owner'));
  });

  test('a dark deployment says so instead of calling anything', async () => {
    capabilityEnabled = false;
    renderPane();
    await screen.findByTestId('ports-pane-dark');
    expect(mockFetchJSON).not.toHaveBeenCalled();
  });

  test('Scan lists what is listening: a dev port pickable, a database port disabled with its reason', async () => {
    mockPost.mockResolvedValueOnce(LISTING);
    renderPane();
    await waitFor(() => expect(screen.getByTestId('ports-scan')).toBeEnabled());
    fireEvent.click(screen.getByTestId('ports-scan'));
    await screen.findByTestId('ports-list');
    expect(mockPost).toHaveBeenCalledWith(PORTS_PATH, {});
    expect(screen.getByTestId('ports-pick-3000')).toBeEnabled();
    const db = screen.getByTestId('ports-pick-5432');
    expect(db).toBeDisabled();
    expect(db).toHaveAttribute('title', expect.stringContaining('database'));
  });

  test('a pick posts SELECT with the port and the instance the list was shown against, refetches the status, and folds the list away', async () => {
    mockPost
      .mockResolvedValueOnce(LISTING) // scan
      .mockResolvedValueOnce({ ok: true, applied: { action: 'start-relay' } }); // select
    renderPane();
    await waitFor(() => expect(screen.getByTestId('ports-scan')).toBeEnabled());
    fireEvent.click(screen.getByTestId('ports-scan'));
    await screen.findByTestId('ports-pick-3000');
    const statusReads = mockFetchJSON.mock.calls.length;
    fireEvent.click(screen.getByTestId('ports-pick-3000'));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(ACTIONS_PATH, { action: 'select', port: 3000, spriteInstanceId: 'inst-live' }));
    // The pane is the preview again: no list, no re-probe (the status poll
    // is what surfaces the relay coming up), and the status was re-asked.
    await waitFor(() => expect(screen.queryByTestId('ports-list')).toBeNull());
    expect(mockPost).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(mockFetchJSON.mock.calls.length).toBeGreaterThan(statusReads));
    expect(screen.queryByTestId('ports-pick-error')).toBeNull();
  });

  test('a refused pick renders the SERVER\'s sentence inline, never silence', async () => {
    mockPost
      .mockResolvedValueOnce(LISTING)
      .mockRejectedValueOnce(new Error('Nothing is listening on port 3000 any more. Scan again to see what is running now.'));
    renderPane();
    await waitFor(() => expect(screen.getByTestId('ports-scan')).toBeEnabled());
    fireEvent.click(screen.getByTestId('ports-scan'));
    await screen.findByTestId('ports-pick-3000');
    fireEvent.click(screen.getByTestId('ports-pick-3000'));
    const error = await screen.findByTestId('ports-pick-error');
    expect(error).toHaveTextContent('Nothing is listening on port 3000 any more');
  });

  test('a plan the server REFUSED inside a 200 (a stranger on 8080) is explained, not swallowed', async () => {
    mockPost
      .mockResolvedValueOnce(LISTING)
      .mockResolvedValueOnce({ ok: true, applied: { action: 'refuse', reason: 'http-port-busy', targetPort: 3000 } });
    renderPane();
    await waitFor(() => expect(screen.getByTestId('ports-scan')).toBeEnabled());
    fireEvent.click(screen.getByTestId('ports-scan'));
    await screen.findByTestId('ports-pick-3000');
    fireEvent.click(screen.getByTestId('ports-pick-3000'));
    const error = await screen.findByTestId('ports-pick-error');
    expect(error).toHaveTextContent('8080');
    // The list stays open so the user can act on the sentence.
    expect(screen.getByTestId('ports-list')).toBeInTheDocument();
  });

  test('a current port that is NOT serving reads "Selected", not "Previewing"', async () => {
    // e.g. the pick landed but a stranger holds 8080: target persisted, relay not up.
    preview = status({ canOpen: false, state: { status: 'down', targetPort: 3000, via: 'relay', error: null, repairable: true, message: 'The preview relay for port 3000 is not running.' } });
    mockPost.mockResolvedValueOnce({ ...LISTING, currentPort: 3000, ports: LISTING.ports.map((p) => ({ ...p, current: p.port === 3000 })) });
    renderPane();
    await waitFor(() => expect(screen.getByTestId('ports-scan')).toBeEnabled());
    fireEvent.click(screen.getByTestId('ports-scan'));
    const row = await screen.findByTestId('ports-pick-3000');
    expect(row).toHaveTextContent('Selected');
    expect(row).not.toHaveTextContent('Previewing');
  });

  test('a failed Scan renders the server\'s sentence', async () => {
    mockPost.mockRejectedValueOnce(new Error('The sandbox did not answer in time when asked which ports are listening. Try Scan again.'));
    renderPane();
    await waitFor(() => expect(screen.getByTestId('ports-scan')).toBeEnabled());
    fireEvent.click(screen.getByTestId('ports-scan'));
    expect(await screen.findByTestId('ports-scan-error')).toHaveTextContent('did not answer in time');
  });

  test('renders the preview frame once the status says it can open, through the open path', async () => {
    preview = status({ canOpen: true, openPath: '/api/agent-workspaces/ws1/preview/open', state: { status: 'live', targetPort: 3000, via: 'relay', message: 'Relaying port 8080 to your dev server on port 3000.' } });
    renderPane();
    const frame = await screen.findByTestId('ports-frame');
    expect(frame).toHaveAttribute('src', '/api/agent-workspaces/ws1/preview/open');
    expect(screen.getByTestId('ports-pane-badge')).toHaveTextContent(':3000');
    expect(screen.queryByTestId('ports-list')).toBeNull();
    expect(frame).toHaveAttribute('sandbox', expect.stringContaining('allow-scripts'));
    // Reload bumps the nonce, forcing a fresh navigation through the handshake.
    await act(async () => { fireEvent.click(screen.getByTestId('ports-reload')); });
    await waitFor(() => expect(screen.getByTestId('ports-frame')).toHaveAttribute('src', '/api/agent-workspaces/ws1/preview/open?r=1'));
  });
});

describe('PortsPane — the chrome that governs the preview', () => {
  const live = (over: Partial<DevPreviewStatusDTO> = {}) =>
    status({
      state: { status: 'live', targetPort: 3000, via: 'relay', message: 'Relaying port 8080 to your dev server on port 3000.' },
      openPath: '/api/agent-workspaces/ws1/preview/open',
      canOpen: true,
      canStop: true,
      ...over,
    });

  test('a live preview: the frame loads the app-origin /preview/open route, the new-tab link targets the same route top-level, the badge is honest, and the pane holds an editing session', async () => {
    preview = live();
    const { unmount } = renderPane();
    const frame = await screen.findByTestId('ports-frame');
    expect(frame).toHaveAttribute('src', '/api/agent-workspaces/ws1/preview/open');
    expect(frame).toHaveAttribute('sandbox', expect.stringContaining('allow-same-origin'));
    expect(screen.getByTestId('ports-pane-badge')).toHaveTextContent('Live');
    const link = screen.getByTestId('ports-new-tab');
    expect(link).toHaveAttribute('href', '/api/agent-workspaces/ws1/preview/open');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    // Repo rule: an auth refresh or an SWR revalidation must not tear down a frame in use.
    expect(useEditingStore.getState().activeSessions.has('dev-preview-pane-ws1')).toBe(true);
    unmount();
    expect(useEditingStore.getState().activeSessions.has('dev-preview-pane-ws1')).toBe(false);
  });

  test('STOP posts the action and re-reads; RESUME appears once the server says so; the manage verdict is read LIVE, never snapshotted', async () => {
    preview = live();
    renderPane();
    await screen.findByTestId('ports-frame');
    const before = mockFetchJSON.mock.calls.length;
    preview = live({ canOpen: false, canStop: false, canResume: true, state: { status: 'stopped', targetPort: 3000, stoppedAt: '2026-09-06T12:00:00.000Z', message: 'Preview of port 3000 is switched off.' } });
    fireEvent.click(screen.getByTestId('ports-stop'));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(ACTIONS_PATH, { action: 'stop' }));
    await waitFor(() => expect(mockFetchJSON.mock.calls.length).toBeGreaterThan(before));
    await screen.findByTestId('ports-resume');
    expect(screen.queryByTestId('ports-stop')).toBeNull();
    // The frame was shown, so it STAYS mounted; the status line explains, once.
    expect(screen.getByTestId('ports-frame')).toBeInTheDocument();
    expect(screen.queryByTestId('ports-placeholder')).toBeNull();
    expect(screen.getByTestId('dev-preview-status-line')).toHaveTextContent('Preview of port 3000 is switched off.');
    expect(screen.getAllByText('Preview of port 3000 is switched off.')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('ports-resume'));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(ACTIONS_PATH, { action: 'resume' }));

    preview = live({ canManage: false });
    fireEvent.click(screen.getByTestId('ports-reload'));
    await waitFor(() => expect(screen.queryByTestId('ports-resume')).toBeNull());
    expect(screen.queryByTestId('ports-stop')).toBeNull();
  });

  test('NEEDS APPROVAL: no frame, the audience is stated, Share posts the PORT that was shown — and a viewer who may not manage is offered no way to share', async () => {
    preview = status({ canOpen: false, canApprove: true, spriteInstanceId: 'inst-live', state: { status: 'needs-approval', targetPort: 9000, message: 'A dev server is running on port 9000. It is not a usual dev-server port, so it is not being shared until you say so.' } });
    const { unmount } = renderPane();
    await screen.findByTestId('ports-placeholder');
    expect(screen.queryByTestId('ports-frame')).toBeNull();
    expect(screen.getByText('Anyone who can open this session will be able to open it.')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ports-share'));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(ACTIONS_PATH, { action: 'approve', port: 9000, spriteInstanceId: 'inst-live' }));
    unmount();

    mockPost.mockClear();
    preview = status({ canManage: false, canOpen: false, canApprove: true, spriteInstanceId: 'inst-live', state: { status: 'needs-approval', targetPort: 9000, message: 'not shared yet' } });
    renderPane();
    await screen.findByTestId('ports-placeholder');
    expect(screen.queryByTestId('ports-share')).toBeNull();
  });

  test('the Share control survives the frame having been armed — a live preview that MOVES to a new unlisted port can still be approved', async () => {
    // `frameArmed` latches on the first openable answer and never clears, so a
    // Share control living only in its `else` branch would be unreachable for
    // the rest of the pane's life. Approval is per PORT.
    preview = live({ spriteInstanceId: 'inst-live' });
    renderPane();
    await screen.findByTestId('ports-frame');
    preview = live({ canOpen: false, canApprove: true, spriteInstanceId: 'inst-live', state: { status: 'needs-approval', targetPort: 9000, message: 'A dev server is running on port 9000.' } });
    fireEvent.click(screen.getByTestId('ports-reload'));
    await screen.findByTestId('ports-share');
    expect(screen.getByTestId('ports-frame')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ports-share'));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(ACTIONS_PATH, { action: 'approve', port: 9000, spriteInstanceId: 'inst-live' }));
  });

  test('RE-AUTH: a reauth-required message FROM OUR FRAME about THIS holder re-points the frame; other sources, holders and shapes are ignored; repeats are debounced; the user\'s own Reload never is', async () => {
    // Without this the frame sits on the "session expired" page for the rest
    // of the cookie's life — the pane is the only listener there is.
    preview = live();
    renderPane();
    const frame = (await screen.findByTestId('ports-frame')) as HTMLIFrameElement;
    const source = frame.contentWindow;
    expect(source).not.toBeNull();
    const reauth = { type: 'pagespace:dev-preview', event: 'reauth-required', holder: { kind: 'workspace', id: 'ws1' } };

    act(() => { window.dispatchEvent(new MessageEvent('message', { data: reauth })); });
    act(() => { window.dispatchEvent(new MessageEvent('message', { data: reauth, source: window })); });
    act(() => { window.dispatchEvent(new MessageEvent('message', { data: { ...reauth, holder: { kind: 'workspace', id: 'other' } }, source })); });
    act(() => { window.dispatchEvent(new MessageEvent('message', { data: { ...reauth, event: 'something-else' }, source })); });
    act(() => { window.dispatchEvent(new MessageEvent('message', { data: 'not an object', source })); });
    expect(screen.getByTestId('ports-frame')).toHaveAttribute('src', '/api/agent-workspaces/ws1/preview/open');

    act(() => { window.dispatchEvent(new MessageEvent('message', { data: reauth, source })); });
    await waitFor(() => expect(screen.getByTestId('ports-frame')).toHaveAttribute('src', '/api/agent-workspaces/ws1/preview/open?r=1'));
    // Each accepted message is a grant row server-side: a spam of repeats mints nothing more.
    const again = (screen.getByTestId('ports-frame') as HTMLIFrameElement).contentWindow;
    for (let i = 0; i < 5; i += 1) act(() => { window.dispatchEvent(new MessageEvent('message', { data: reauth, source: again })); });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByTestId('ports-frame')).toHaveAttribute('src', '/api/agent-workspaces/ws1/preview/open?r=1');

    fireEvent.click(screen.getByTestId('ports-reload'));
    await waitFor(() => expect(screen.getByTestId('ports-frame')).toHaveAttribute('src', '/api/agent-workspaces/ws1/preview/open?r=2'));
  });

  test('a DEFERRED action says so rather than looking like it did nothing; a failed one toasts and still re-reads', async () => {
    preview = live({ canOpen: false, canStop: false, canResume: true, state: { status: 'stopped', targetPort: 3000, stoppedAt: 'x', message: 'Preview of port 3000 is switched off.' } });
    renderPane();
    await screen.findByTestId('ports-resume');
    mockPost.mockResolvedValueOnce({ deferred: 'awaiting-reconcile' });
    fireEvent.click(screen.getByTestId('ports-resume'));
    await waitFor(() => expect(mockToastInfo).toHaveBeenCalledWith('The preview will start shortly', expect.objectContaining({ description: expect.stringContaining('being applied first') })));

    const before = mockFetchJSON.mock.calls.length;
    mockPost.mockRejectedValueOnce(new Error('nope'));
    fireEvent.click(screen.getByTestId('ports-resume'));
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('Could not switch the preview on', expect.objectContaining({ description: 'nope' })));
    await waitFor(() => expect(mockFetchJSON.mock.calls.length).toBeGreaterThan(before));
  });
});
