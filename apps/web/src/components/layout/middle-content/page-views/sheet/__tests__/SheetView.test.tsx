import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createEmptySheet, serializeSheetContent } from '@pagespace/lib/sheets/sheet';

// `serializeSheetContent` refuses to emit content it cannot parse back, so it
// can throw on an edit. Spying lets a test force that without a contrived
// document.
vi.mock('@pagespace/lib/sheets/sheet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pagespace/lib/sheets/sheet')>();
  return { ...actual, serializeSheetContent: vi.fn(actual.serializeSheetContent) };
});

/**
 * Render coverage for SheetView.
 *
 * Everything else under `sheet/` is a pure helper or a hook, so until this file
 * existed the component itself had never been mounted in a test — including the
 * read-only gating, the load-failure banner, and the guard that stops a
 * serialization error escaping a React state update.
 */

const documentState: { current: { content: string; isDirty: boolean } | undefined } = {
  current: undefined,
};
const lacksEditPermission = { current: false };

/**
 * `useSheetPersistence` runs for real; only its boundary to the store and the
 * network is mocked. That is deliberate — SheetView's read-only gating is
 * driven by the `loadError` that hook derives, so stubbing the hook would test
 * the stub. This way an unparseable document really does flow through
 * `parseSheetContentSafe` into the banner and the gating.
 */
vi.mock('@/hooks/useDocument', () => ({
  useDocument: () => ({
    document: documentState.current ? { ...documentState.current } : undefined,
    isLoading: false,
    isSaving: false,
    initializeAndActivate: vi.fn(),
    updateContent: vi.fn(),
    updateContentFromServer: vi.fn(),
    saveWithDebounce: vi.fn(),
    forceSave: vi.fn().mockResolvedValue(undefined),
    clearDocument: vi.fn(),
    conflict: null,
    resolveConflict: vi.fn(),
    isResolvingConflict: false,
  }),
}));

vi.mock('../hooks/useSheetPermissions', () => ({
  useSheetPermissions: () => lacksEditPermission.current,
}));

vi.mock('@/hooks/useSocket', () => ({ useSocket: () => null }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
vi.mock('@/hooks/usePageTree', () => ({ usePageTree: () => ({ tree: [] }) }));
vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/stores/useEditingSession', () => ({ useEditingSession: vi.fn() }));

// Mirrors the real hook's surface; SheetView reads `query` and `actions`.
vi.mock('@/hooks/useSuggestion', () => ({
  useSuggestion: () => ({
    handleValueChange: vi.fn(),
    handleKeyDown: vi.fn(),
    isOpen: false,
    position: null,
    items: [],
    selectedIndex: 0,
    loading: false,
    error: null,
    query: '',
    actions: { selectSuggestion: vi.fn(), close: vi.fn() },
  }),
}));

vi.mock('@/components/providers/SuggestionProvider', () => ({
  SuggestionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useSuggestionContext: () => ({ isOpen: false, position: null, items: [] }),
}));

vi.mock(
  '@/components/layout/middle-content/page-views/document/DocumentConflictGate',
  () => ({ default: () => null })
);

vi.mock('@/components/ui/pull-to-refresh', () => ({
  PullToRefresh: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/ui/custom-scroll-area', () => ({
  CustomScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }));

import SheetView from '../SheetView';

type SheetViewProps = React.ComponentProps<typeof SheetView>;
type TestPage = SheetViewProps['page'];

/** A minimal TreePage; SheetView reads only these fields. */
const makePage = (content: string): TestPage =>
  ({
    id: 'page-1',
    title: 'Budget',
    driveId: 'drive-1',
    parentId: null,
    type: 'SHEET',
    content,
  }) as unknown as TestPage;

/** Carries the SheetDoc magic but a malformed body, so parsing genuinely fails. */
const UNPARSEABLE = '#%PAGESPACE_SHEETDOC v1\nthis is [not toml';

const contentWith = (cells: Record<string, string>) => {
  const sheet = createEmptySheet();
  Object.assign(sheet.cells, cells);
  return serializeSheetContent(sheet);
};

describe('SheetView', () => {
  beforeEach(() => {
    lacksEditPermission.current = false;
    // A primed `mockImplementationOnce` that never fires would leak into the
    // next test's setup, so clear any leftover between tests.
    vi.mocked(serializeSheetContent).mockClear();
    documentState.current = { content: contentWith({ A1: 'hello' }), isDirty: false };
    toastError.mockClear();
  });

  it('renders the grid without crashing', () => {
    render(<SheetView page={makePage(contentWith({ A1: 'hello' }))} />);

    expect(screen.getByRole('grid')).toBeTruthy();
    expect(screen.getByText('hello')).toBeTruthy();
  });

  it('shows no load-failure banner when the sheet reads fine', () => {
    render(<SheetView page={makePage(contentWith({ A1: 'hello' }))} />);

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('surfaces a banner when the stored content could not be read', () => {
    // The alternative is handing the editor an empty sheet, which autosaves
    // straight over content we merely failed to parse. The failure is derived
    // from real content through the real hook, not injected.
    documentState.current = { content: UNPARSEABLE, isDirty: false };

    render(<SheetView page={makePage(UNPARSEABLE)} />);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('could not be loaded');
    expect(alert.textContent).toContain('editing is disabled');
  });

  it('still renders the grid while the load error is showing', () => {
    // The banner must not replace the view — a user should still see whatever
    // did parse, and be able to select and copy it.
    documentState.current = { content: UNPARSEABLE, isDirty: false };

    render(<SheetView page={makePage(UNPARSEABLE)} />);

    expect(screen.getByRole('grid')).toBeTruthy();
  });

  const cellAt = (address: string) =>
    screen.getByRole('grid').querySelector(`[data-cell="${address}"]`) as HTMLElement;

  it('lets a view-only user select a cell', () => {
    // Selection is not a mutation: a viewer needs it to read a range, copy it,
    // and see the sum/average footer. This is the behaviour, not the render —
    // asserting only that cells exist passes even with selection blocked.
    lacksEditPermission.current = true;

    render(<SheetView page={makePage(contentWith({ A1: 'hello' }))} />);

    expect(cellAt('A1').getAttribute('aria-selected')).toBe('true');

    fireEvent.mouseDown(cellAt('B2'));

    expect(cellAt('B2').getAttribute('aria-selected')).toBe('true');
    expect(cellAt('A1').getAttribute('aria-selected')).toBe('false');
  });

  it('lets a view-only user drag out a range', () => {
    lacksEditPermission.current = true;

    render(<SheetView page={makePage(contentWith({ A1: 'hello' }))} />);

    fireEvent.mouseDown(cellAt('A1'));
    fireEvent.mouseEnter(cellAt('B2'));

    // The whole rectangle is selected, which is what makes the footer stats
    // and a range copy work for someone who cannot edit.
    for (const address of ['A1', 'A2', 'B1', 'B2']) {
      expect(cellAt(address).getAttribute('aria-selected'), address).toBe('true');
    }
  });

  it('marks cells read-only for a view-only user', () => {
    lacksEditPermission.current = true;

    render(<SheetView page={makePage(contentWith({ A1: 'hello' }))} />);

    expect(screen.getAllByRole('gridcell')[0].getAttribute('aria-readonly')).toBe('true');
  });

  it('survives a serialization failure instead of blanking the page', () => {
    // The throw happens inside a React state updater. Uncaught, it escapes to
    // the nearest error boundary and takes the whole view with it. "+ Row" is
    // the shortest path that definitely reaches the persist helper.
    render(<SheetView page={makePage(contentWith({ A1: 'hello' }))} />);

    vi.mocked(serializeSheetContent).mockImplementationOnce(() => {
      throw new Error('Refusing to emit a SheetDoc that cannot be parsed back');
    });

    fireEvent.click(screen.getAllByRole('button', { name: 'Add row' })[0]);

    // The toast is the load-bearing assertion: it only appears if the throw
    // was caught. `fireEvent` does not rethrow, so asserting "did not throw"
    // passes with or without the guard.
    expect(toastError).toHaveBeenCalledWith('That change could not be saved and was undone.');

    // And the view survived, still showing the last good value.
    expect(screen.getByRole('grid')).toBeTruthy();
    expect(screen.getByText('hello')).toBeTruthy();
  });

  it('renders a formatted value the way the engine computed it', () => {
    const sheet = createEmptySheet();
    sheet.cells.B1 = '1234.5';
    sheet.formats = { B1: { number: { kind: 'currency', currency: 'USD' } } };
    const content = serializeSheetContent(sheet);
    documentState.current = { content, isDirty: false };

    render(<SheetView page={makePage(content)} />);

    expect(screen.getByText('$1,234.50')).toBeTruthy();
  });
});
