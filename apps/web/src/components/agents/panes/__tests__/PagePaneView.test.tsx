/**
 * PagePaneView — the pane-safe page-type dispatch. Leaf view components are
 * mocked (this suite is the dispatch/loading/error wiring, not their
 * internals, same convention as `AgentPanes.test.tsx`'s `PaneChat`/`Shell`
 * mocks). A fresh `SWRConfig` cache per render keeps tests from bleeding into
 * each other.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

const mockFetchWithAuth = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

vi.mock('@/components/layout/middle-content/page-views/document/DocumentView', () => ({
  default: ({ pageId, driveId }: { pageId: string; driveId?: string }) => (
    <div data-testid="document-view">
      {pageId}:{driveId ?? 'no-drive'}
    </div>
  ),
}));
vi.mock('@/components/layout/middle-content/page-views/code/CodePageView', () => ({
  default: ({ pageId }: { pageId: string }) => <div data-testid="code-view">{pageId}</div>,
}));
vi.mock('@/components/layout/middle-content/page-views/canvas/CanvasPageView', () => ({
  default: ({ pageId }: { pageId: string }) => <div data-testid="canvas-view">{pageId}</div>,
}));
vi.mock('@/components/layout/middle-content/page-views/channel/ChannelView', () => ({
  default: ({ page }: { page: { id: string } }) => <div data-testid="channel-view">{page.id}</div>,
}));
vi.mock('@/components/layout/middle-content/page-views/file/FileViewer', () => ({
  default: ({ page }: { page: { id: string } }) => <div data-testid="file-view">{page.id}</div>,
}));
vi.mock('@/components/layout/middle-content/page-views/sheet/SheetView', () => ({
  default: ({ page }: { page: { id: string } }) => <div data-testid="sheet-view">{page.id}</div>,
}));
vi.mock('@/components/layout/middle-content/page-views/task-list/TaskListView', () => ({
  default: ({ page }: { page: { id: string } }) => <div data-testid="task-list-view">{page.id}</div>,
}));

import PagePaneView from '../PagePaneView';

const jsonOk = (body: unknown) => ({ ok: true, json: async () => body });
const jsonErr = (status: number, body: unknown = { error: 'nope' }) => ({ ok: false, status, json: async () => body });

function renderPane(pageId = 'page-1') {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PagePaneView pageId={pageId} />
    </SWRConfig>,
  );
}

describe('PagePaneView', () => {
  it('shows a loading skeleton before the page fetch resolves', () => {
    mockFetchWithAuth.mockReturnValue(new Promise(() => {})); // never resolves
    const { container } = renderPane();
    expect(container.querySelector('[class*="animate-pulse"]')).not.toBeNull();
  });

  it('shows an error message when the fetch fails', async () => {
    mockFetchWithAuth.mockResolvedValue(jsonErr(403, { error: 'You do not have permission to view this page' }));
    renderPane();
    expect(await screen.findByText('You do not have permission to view this page')).toBeInTheDocument();
  });

  it('renders DocumentView with pageId + the PAGE\'s own driveId (not a session driveId)', async () => {
    mockFetchWithAuth.mockResolvedValue(
      jsonOk({ id: 'page-1', type: 'DOCUMENT', driveId: 'drive-owning-the-page' }),
    );
    renderPane();
    expect(await screen.findByTestId('document-view')).toHaveTextContent('page-1:drive-owning-the-page');
  });

  it('renders CodePageView with pageId only', async () => {
    mockFetchWithAuth.mockResolvedValue(jsonOk({ id: 'page-1', type: 'CODE', driveId: 'drive-1' }));
    renderPane();
    expect(await screen.findByTestId('code-view')).toHaveTextContent('page-1');
  });

  it('renders CanvasPageView with pageId only', async () => {
    mockFetchWithAuth.mockResolvedValue(jsonOk({ id: 'page-1', type: 'CANVAS', driveId: 'drive-1' }));
    renderPane();
    expect(await screen.findByTestId('canvas-view')).toHaveTextContent('page-1');
  });

  it('renders SheetView with the full page object', async () => {
    mockFetchWithAuth.mockResolvedValue(jsonOk({ id: 'page-1', type: 'SHEET', driveId: 'drive-1' }));
    renderPane();
    expect(await screen.findByTestId('sheet-view')).toHaveTextContent('page-1');
  });

  it('renders TaskListView with the full page object', async () => {
    mockFetchWithAuth.mockResolvedValue(jsonOk({ id: 'page-1', type: 'TASK_LIST', driveId: 'drive-1' }));
    renderPane();
    expect(await screen.findByTestId('task-list-view')).toHaveTextContent('page-1');
  });

  it('renders ChannelView with the full page object', async () => {
    mockFetchWithAuth.mockResolvedValue(jsonOk({ id: 'page-1', type: 'CHANNEL', driveId: 'drive-1' }));
    renderPane();
    expect(await screen.findByTestId('channel-view')).toHaveTextContent('page-1');
  });

  it('renders FileViewer with the full page object', async () => {
    mockFetchWithAuth.mockResolvedValue(jsonOk({ id: 'page-1', type: 'FILE', driveId: 'drive-1' }));
    renderPane();
    expect(await screen.findByTestId('file-view')).toHaveTextContent('page-1');
  });

  it('shows an unsupported message for FOLDER — a stale persisted scope must never crash', async () => {
    mockFetchWithAuth.mockResolvedValue(jsonOk({ id: 'page-1', type: 'FOLDER', driveId: 'drive-1' }));
    renderPane();
    await waitFor(() => {
      expect(screen.getByText(/can.t be opened in a pane/i)).toBeInTheDocument();
    });
  });

  it('shows an unsupported message for AI_CHAT — never nests a chat inside a chat pane', async () => {
    mockFetchWithAuth.mockResolvedValue(jsonOk({ id: 'page-1', type: 'AI_CHAT', driveId: 'drive-1' }));
    renderPane();
    await waitFor(() => {
      expect(screen.getByText(/can.t be opened in a pane/i)).toBeInTheDocument();
    });
  });
});
