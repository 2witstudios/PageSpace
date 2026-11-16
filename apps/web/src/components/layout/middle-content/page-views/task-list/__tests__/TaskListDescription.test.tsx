import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useDocumentManagerStore } from '@/stores/useDocumentManagerStore';

/**
 * The description's load paths. Tree nodes no longer carry content, so an
 * uncached description is fetched; these guard that a slow or failed fetch can
 * neither be edited over nor cached as an empty description.
 */

type DocState = { content: string; isDirty: boolean };
const docRef: { current: DocState | undefined } = { current: undefined };
const initializeAndActivate = vi.fn<(options?: { emptyOnFailure?: boolean }) => Promise<boolean>>();
const saveWithDebounce = vi.fn();

vi.mock('@/hooks/useDocument', () => ({
  useDocument: () => ({
    document: docRef.current ? { ...docRef.current } : undefined,
    updateContent: vi.fn(),
    saveWithDebounce,
    forceSave: vi.fn().mockResolvedValue(undefined),
    initializeAndActivate,
    conflict: undefined,
    resolveConflict: vi.fn(),
    isResolvingConflict: false,
  }),
}));

vi.mock('@/components/layout/middle-content/page-views/document/DocumentConflictGate', () => ({
  default: () => null,
}));

vi.mock('next/dynamic', () => ({
  default: () =>
    function RichEditorStub({ value, readOnly, onChange }: { value: string; readOnly: boolean; onChange: (html: string) => void }) {
      return (
        <textarea
          aria-label="description"
          value={value}
          readOnly={readOnly}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    },
}));

import { TaskListDescriptionContent } from '../TaskListDescription';

describe('TaskListDescriptionContent', () => {
  beforeEach(() => {
    docRef.current = undefined;
    initializeAndActivate.mockReset();
    saveWithDebounce.mockReset();
    useDocumentManagerStore.setState({ documents: new Map() });
  });

  it('fetches without an empty fallback and stays read-only until the document exists', () => {
    initializeAndActivate.mockReturnValue(new Promise(() => {}));

    render(<TaskListDescriptionContent pageId="tl-1" canEdit />);

    expect(initializeAndActivate).toHaveBeenCalledWith({ emptyOnFailure: false });
    const editor = screen.getByLabelText('description') as HTMLTextAreaElement;
    expect(editor.readOnly).toBe(true);
  });

  it('is editable once the document has loaded', () => {
    initializeAndActivate.mockResolvedValue(true);
    docRef.current = { content: '<p>hi</p>', isDirty: false };
    useDocumentManagerStore.getState().upsertDocument('tl-1', '<p>hi</p>', 'html');

    render(<TaskListDescriptionContent pageId="tl-1" canEdit />);

    const editor = screen.getByLabelText('description') as HTMLTextAreaElement;
    expect(editor.readOnly).toBe(false);
  });

  it('shows a retry instead of an editable empty description when the fetch fails', async () => {
    initializeAndActivate.mockResolvedValueOnce(false).mockReturnValueOnce(new Promise(() => {}));

    render(<TaskListDescriptionContent pageId="tl-1" canEdit />);

    const retry = await screen.findByRole('button', { name: /retry/i });
    expect(screen.queryByLabelText('description')).toBeNull();

    fireEvent.click(retry);
    await waitFor(() => expect(initializeAndActivate).toHaveBeenCalledTimes(2));
    expect(initializeAndActivate).toHaveBeenLastCalledWith({ emptyOnFailure: false });
  });
});
