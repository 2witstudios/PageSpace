import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useDocumentManagerStore } from '@/stores/useDocumentManagerStore';
import { useDirtyStore } from '@/stores/useDirtyStore';

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ content: 'saved', revision: 12 }),
  }),
}));

vi.mock('@/hooks/useSocket', () => ({
  useSocket: vi.fn(() => ({ id: 'socket-123' })),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
}));

import DocumentConflictGate from '../DocumentConflictGate';

const pageId = 'page-123';

describe('DocumentConflictGate', () => {
  beforeEach(() => {
    useDocumentManagerStore.setState({
      documents: new Map(),
      activeDocumentId: null,
      savingDocuments: new Set(),
      conflicts: new Map(),
    });
    useDirtyStore.setState({ dirtyFlags: {} });
    vi.clearAllMocks();
  });

  it('given no conflict, should render nothing so views can mount it unconditionally', () => {
    useDocumentManagerStore.getState().upsertDocument(pageId, 'my text', 'html', 3);

    const { container } = render(<DocumentConflictGate pageId={pageId} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('given a parked conflict, should surface the resolve UI', () => {
    useDocumentManagerStore.getState().upsertDocument(pageId, 'my text', 'html', 3);

    render(<DocumentConflictGate pageId={pageId} />);

    act(() => {
      useDocumentManagerStore.getState().setConflict(pageId, {
        remoteContent: 'their text',
        remoteRevision: 11,
        detectedAt: 1,
      });
    });

    expect(screen.getByTestId('document-conflict-banner')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep mine' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use theirs' })).toBeInTheDocument();
  });
});
