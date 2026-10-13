// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MultiSelection } from './use-multi-select';

const state = vi.hoisted(() => ({
  client: { apiFetch: vi.fn(), apiStream: vi.fn() },
  toast: { loading: vi.fn(() => 'id'), success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/api/swr-provider', () => ({ useApiClient: () => state.client }));
vi.mock('@/retained-adapters/retained-provider', () => ({ RetainedSurface: ({ children }: { children: unknown }) => children }));
vi.mock('sonner', () => ({ toast: state.toast }));

import { MultiSelectToolbar } from './multi-select-toolbar';

const selection = (overrides: Partial<MultiSelection> = {}): MultiSelection => ({
  active: true,
  selectedIds: new Set(['a', 'b', 'c']),
  pageIds: ['a', 'b', 'c'],
  rowSelection: undefined,
  exit: vi.fn(),
  clear: vi.fn(),
  ...overrides,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MultiSelectToolbar (IMC-9.6)', () => {
  it('shows nothing while Select multiple is off', () => {
    render(<MultiSelectToolbar selection={selection({ active: false })} />);
    expect(screen.queryByRole('toolbar', { name: 'Multi-select' })).toBeNull();
  });

  it('shows the count and the Move, Copy, Delete and Cancel actions while selecting', () => {
    render(<MultiSelectToolbar selection={selection()} />);
    const toolbar = screen.getByRole('toolbar', { name: 'Multi-select' });
    expect(toolbar.textContent).toContain('3 selected');
    expect(screen.getByRole('button', { name: 'Move' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel selection' })).toBeTruthy();
  });

  it('cancel leaves the mode', () => {
    const sel = selection();
    render(<MultiSelectToolbar selection={sel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel selection' }));
    expect(sel.exit).toHaveBeenCalled();
  });

  it('Delete asks before anything is trashed', () => {
    render(<MultiSelectToolbar selection={selection()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(screen.getByText('Move to Trash?')).toBeTruthy();
    expect(screen.getByText(/This will move 3 pages and all their children to the trash/)).toBeTruthy();
    expect(state.client.apiFetch).not.toHaveBeenCalled();
  });

  it('confirming trashes every selected page in one request, then toasts', async () => {
    state.client.apiFetch.mockResolvedValue({ trashedCount: 3 });
    const sel = selection();
    render(<MultiSelectToolbar selection={sel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    await waitFor(() => expect(state.toast.success).toHaveBeenCalledWith('Successfully moved 3 pages to trash', { id: 'id' }));
    expect(state.client.apiFetch).toHaveBeenCalledWith('/api/pages/bulk-delete', {
      method: 'DELETE',
      json: { pageIds: ['a', 'b', 'c'], trashChildren: true },
    });
    expect(sel.exit).toHaveBeenCalled();
  });

  it('a failed trash keeps the selection and says so', async () => {
    state.client.apiFetch.mockRejectedValue(new Error('down'));
    const sel = selection();
    render(<MultiSelectToolbar selection={sel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    await waitFor(() => expect(state.toast.error).toHaveBeenCalled());
    expect(sel.exit).not.toHaveBeenCalled();
  });
});
