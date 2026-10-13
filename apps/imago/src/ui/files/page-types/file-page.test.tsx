// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { TreePage } from '@/retained/hooks/usePageTree';
import { FilePage } from './file-page';

const state = vi.hoisted(() => ({
  tree: [] as TreePage[],
  fetch: vi.fn(),
}));

vi.mock('next/dynamic', () => ({ default: () => () => <span data-testid="file-view" /> }));
vi.mock('@/retained/hooks/usePageTree', () => ({ usePageTree: () => ({ tree: state.tree }) }));
vi.mock('@/retained/lib/auth/auth-fetch', () => ({ fetchWithAuth: (...args: unknown[]) => state.fetch(...args) }));

const jsonResponse = (body: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 500, json: async () => body }) as unknown as Response;

const fileNode = (id: string): TreePage =>
  ({ id, type: 'FILE', title: 'Interview — Priya.pdf', originalFileName: 'Interview — Priya.pdf', mimeType: 'application/pdf', fileSize: 1887437, children: [] }) as unknown as TreePage;

const renderFile = (pageId: string) =>
  render(<FilePage page={fileNode(pageId)} driveId="drive" pageId={pageId} />);

afterEach(() => {
  cleanup();
  state.tree = [];
  state.fetch.mockReset();
});

describe('FilePage Page tools strip', () => {
  it('labels the strip and shows the MIME type and size from the tree DTO', () => {
    state.tree = [fileNode('file-facts')];
    state.fetch.mockResolvedValue(jsonResponse({ status: 'pending' }));
    renderFile('file-facts');
    expect(screen.getByRole('toolbar', { name: 'Page tools' })).toBeTruthy();
    expect(screen.getByText('application/pdf · 1.8 MB')).toBeTruthy();
  });

  it('offers Download beside the file facts', () => {
    state.fetch.mockResolvedValue(jsonResponse({ status: 'pending' }));
    renderFile('file-download');
    expect(screen.getByRole('button', { name: /Download/ })).toBeTruthy();
  });

  it('omits the facts when the tree has not yet listed the file', () => {
    state.fetch.mockResolvedValue(jsonResponse({ status: 'pending' }));
    renderFile('file-missing');
    const strip = screen.getByRole('toolbar', { name: 'Page tools' });
    expect(strip.textContent).not.toContain('·');
  });
});

describe('FilePage processing status', () => {
  it('reads the file processing-status endpoint and says the text is readable once extracted', async () => {
    state.tree = [fileNode('file-done')];
    state.fetch.mockResolvedValue(jsonResponse({ status: 'completed' }));
    renderFile('file-done');
    expect(await screen.findByText('Text extracted · readable by AI')).toBeTruthy();
    expect(state.fetch.mock.calls[0]?.[0]).toBe('/api/pages/file-done/processing-status');
  });

  it('shows a processing state while extraction is still in flight', async () => {
    state.tree = [fileNode('file-busy')];
    state.fetch.mockResolvedValue(jsonResponse({ status: 'processing' }));
    renderFile('file-busy');
    expect(await screen.findByText('Processing…')).toBeTruthy();
    expect(screen.queryByText('Text extracted · readable by AI')).toBeNull();
  });

  it('shows a failed state when extraction failed', async () => {
    state.tree = [fileNode('file-failed')];
    state.fetch.mockResolvedValue(jsonResponse({ status: 'failed' }));
    renderFile('file-failed');
    expect(await screen.findByText('Processing failed')).toBeTruthy();
  });

  it('shows no chip when the status cannot be read', async () => {
    state.fetch.mockResolvedValue(jsonResponse({}, false));
    renderFile('file-unreadable');
    await vi.waitFor(() => expect(state.fetch).toHaveBeenCalled());
    expect(screen.queryByText(/Processing|Text extracted/)).toBeNull();
  });
});
