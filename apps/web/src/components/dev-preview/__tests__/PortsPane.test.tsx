/**
 * The preview pane against real hooks: it NEVER probes on mount (a persisted,
 * multi-viewer pane must not bill a wake per reload), the list appears only
 * behind the header's Ports control, a pick echoes the listing's instance and
 * folds the list away, and every failure is the server's own sentence,
 * inline — never silence.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { SWRConfig } from 'swr';

const mockFetchJSON = vi.hoisted(() => vi.fn());
const mockPost = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/auth-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/auth-fetch')>();
  return { ...actual, fetchJSON: (...args: unknown[]) => mockFetchJSON(...args), post: (...args: unknown[]) => mockPost(...args) };
});

import { PortsPane } from '../PortsPane';
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
    expect(screen.getByTestId('ports-pane-port')).toHaveTextContent(':3000');
    expect(screen.queryByTestId('ports-list')).toBeNull();
    expect(frame).toHaveAttribute('sandbox', expect.stringContaining('allow-scripts'));
    // Reload bumps the nonce, forcing a fresh navigation through the handshake.
    await act(async () => { fireEvent.click(screen.getByTestId('ports-reload')); });
    await waitFor(() => expect(screen.getByTestId('ports-frame')).toHaveAttribute('src', '/api/agent-workspaces/ws1/preview/open?r=1'));
  });
});
