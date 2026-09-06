import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  MAX_CONDITIONAL_RULES,
  createEmptySheet,
  parseSheetContent,
  serializeSheetContent,
  setCellFormats,
  setColumnFormat,
} from '@pagespace/lib/sheets/sheet';

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

/** The rendered text of one grid cell, by address. */
const cellText = (address: string): string =>
  document.querySelector(`[data-cell="${address}"]`)?.textContent ?? '';

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
    expect(cellText('A1')).toBe('hello');
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

  it('paints a cell that has a fill but no value', () => {
    // The dashboard case, and the one nothing else covers: `setCellFormats`
    // writes to `sheet.formats`, not `sheet.cells`, so a blank coloured cell has
    // no entry in the sparse evaluation. It was persisted and invisible.
    const sheet = createEmptySheet();
    const content = serializeSheetContent(setCellFormats(sheet, ['C3'], { background: '#dbeafe' }));
    documentState.current = { content, isDirty: false };

    render(<SheetView page={makePage(content)} />);

    expect(cellAt('C3').style.backgroundColor).toBe('rgb(219, 234, 254)');
  });

  it('applies a column default to the empty cells of that column', () => {
    const content = serializeSheetContent(setColumnFormat(createEmptySheet(), 1, {
      background: '#fee2e2',
    }));
    documentState.current = { content, isDirty: false };

    render(<SheetView page={makePage(content)} />);

    expect(cellAt('B4').style.backgroundColor).toBe('rgb(254, 226, 226)');
  });

  it('paints a conditional rule without the grid knowing about rules', () => {
    // Rules are folded in by the evaluator, so the grid renders them through
    // the same `cell.format` it already used. This pins that: if the evaluator
    // ever stopped resolving them, the grid would quietly go back to plain.
    const sheet = createEmptySheet();
    sheet.cells.A1 = '150';
    sheet.conditionalFormats = [
      {
        id: 'over-100',
        kind: 'cell',
        ranges: ['A1:A9'],
        condition: { operator: 'greaterThan', value: '100' },
        format: { background: '#fee2e2' },
      },
    ];
    const content = serializeSheetContent(sheet);
    documentState.current = { content, isDirty: false };

    render(<SheetView page={makePage(content)} />);

    expect(cellAt('A1').style.backgroundColor).toBe('rgb(254, 226, 226)');
    // A cell the rule does not match stays unpainted.
    expect(cellAt('A2').style.backgroundColor).toBe('');
  });

  it('draws a data bar behind the value, not instead of it', () => {
    // A data bar has no CellFormat field to live in, so it travels separately
    // on the evaluation and is drawn as its own layer. The value must stay
    // readable — that is the whole reason a bar beats a fill.
    const sheet = createEmptySheet();
    Object.assign(sheet.cells, { A1: '0', A2: '10' });
    sheet.conditionalFormats = [
      { id: 'bar', kind: 'dataBar', ranges: ['A1:A2'], color: '#3b82f6' },
    ];
    const content = serializeSheetContent(sheet);
    documentState.current = { content, isDirty: false };

    render(<SheetView page={makePage(content)} />);

    const full = cellAt('A2').querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(full).not.toBeNull();
    expect(full.style.width).toBe('100%');
    expect(cellAt('A2').textContent).toContain('10');

    // A zero-length bar is not drawn at all, rather than a zero-width sliver.
    expect(cellAt('A1').querySelector('[aria-hidden="true"]')).toBeNull();
  });

  describe('the conditional formatting panel', () => {
    const openPanel = () => fireEvent.click(screen.getByLabelText(/^Conditional formatting/));

    it('creates a rule that immediately paints the grid', async () => {
      // The whole point of the panel: a rule made here has to reach the
      // evaluator and come back as a painted cell, not just sit in state.
      const sheet = createEmptySheet();
      Object.assign(sheet.cells, { A1: '150', A2: '10' });
      const content = serializeSheetContent(sheet);
      documentState.current = { content, isDirty: false };

      render(<SheetView page={makePage(content)} />);

      // Select A1:A2 so the new rule defaults to that range.
      fireEvent.mouseDown(cellAt('A1'));
      fireEvent.mouseDown(cellAt('A2'), { shiftKey: true });

      openPanel();
      fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));

      // A fresh single-colour rule compares "greater than" an empty value,
      // which matches nothing until a value is set — so set one.
      fireEvent.click(screen.getByRole('button', { name: /^Edit rule:/ }));
      const value = screen.getByLabelText('Comparison value');
      fireEvent.blur(value, { target: { value: '100' } });

      expect(cellAt('A1').style.backgroundColor).toBe('rgb(254, 226, 226)');
      expect(cellAt('A2').style.backgroundColor).toBe('');
    });

    it('shows the rules already on the sheet, in application order', () => {
      const sheet = createEmptySheet();
      sheet.conditionalFormats = [
        {
          id: 'first', kind: 'cell', ranges: ['A1:A9'],
          condition: { operator: 'isNotEmpty' }, format: { bold: true },
        },
        { id: 'second', kind: 'dataBar', ranges: ['B1:B9'], color: '#3b82f6' },
      ];
      const content = serializeSheetContent(sheet);
      documentState.current = { content, isDirty: false };

      render(<SheetView page={makePage(content)} />);
      openPanel();

      const rows = screen.getAllByRole('button', { name: /Move .* (earlier|later)/ });
      // Two rules, each with an up and a down control.
      expect(rows).toHaveLength(4);
      expect(screen.getByText(/Cell is not empty/)).toBeTruthy();
      expect(screen.getByText(/Data bar/)).toBeTruthy();
    });

    it('reorders rules, which is what decides who wins', () => {
      // Two rules over the same cell setting the same field: the later one
      // paints. Moving it changes the colour, which is the observable proof
      // that order is precedence.
      const sheet = createEmptySheet();
      sheet.cells.A1 = 'x';
      sheet.conditionalFormats = [
        {
          id: 'red', kind: 'cell', ranges: ['A1'],
          condition: { operator: 'isNotEmpty' }, format: { background: '#fee2e2' },
        },
        {
          id: 'green', kind: 'cell', ranges: ['A1'],
          condition: { operator: 'isNotEmpty' }, format: { background: '#dcfce7' },
        },
      ];
      const content = serializeSheetContent(sheet);
      documentState.current = { content, isDirty: false };

      render(<SheetView page={makePage(content)} />);
      expect(cellAt('A1').style.backgroundColor).toBe('rgb(220, 252, 231)');

      openPanel();
      fireEvent.click(screen.getAllByRole('button', { name: /Move .* later/ })[0]);

      expect(cellAt('A1').style.backgroundColor).toBe('rgb(254, 226, 226)');
    });

    it('deletes a rule and stops painting', () => {
      const sheet = createEmptySheet();
      sheet.cells.A1 = 'x';
      sheet.conditionalFormats = [
        {
          id: 'r', kind: 'cell', ranges: ['A1'],
          condition: { operator: 'isNotEmpty' }, format: { background: '#fee2e2' },
        },
      ];
      const content = serializeSheetContent(sheet);
      documentState.current = { content, isDirty: false };

      render(<SheetView page={makePage(content)} />);
      expect(cellAt('A1').style.backgroundColor).toBe('rgb(254, 226, 226)');

      openPanel();
      fireEvent.click(screen.getByRole('button', { name: /^Delete/ }));

      expect(cellAt('A1').style.backgroundColor).toBe('');
    });

    it('says why a rule was refused, rather than losing it silently', () => {
      // Past the ceiling the parser drops the rule on the next load. Accepting
      // it here would look like it worked and then lose it, so the panel has to
      // say no out loud.
      const sheet = createEmptySheet();
      sheet.conditionalFormats = Array.from({ length: MAX_CONDITIONAL_RULES }, (_, i) => ({
        id: `r${i}`,
        kind: 'cell' as const,
        ranges: ['A1'],
        condition: { operator: 'isNotEmpty' as const },
        format: { bold: true },
      }));
      const content = serializeSheetContent(sheet);
      documentState.current = { content, isDirty: false };

      render(<SheetView page={makePage(content)} />);
      openPanel();

      expect(screen.queryByRole('alert')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));

      const alert = screen.getByRole('alert');
      expect(alert.textContent).toContain(String(MAX_CONDITIONAL_RULES));
      // ...and nothing was added.
      expect(screen.getAllByRole('button', { name: /^Delete/ })).toHaveLength(
        MAX_CONDITIONAL_RULES
      );
    });

    it('refuses to widen a rule past the ceiling by editing it', () => {
      // Otherwise editing is a way around the limit that adding refuses.
      const sheet = createEmptySheet();
      sheet.cells.A1 = 'x';
      sheet.conditionalFormats = [
        {
          id: 'r', kind: 'cell', ranges: ['A1:A9'],
          condition: { operator: 'isNotEmpty' }, format: { background: '#fee2e2' },
        },
      ];
      const content = serializeSheetContent(sheet);
      documentState.current = { content, isDirty: false };

      render(<SheetView page={makePage(content)} />);
      openPanel();
      fireEvent.click(screen.getByRole('button', { name: /^Edit rule:/ }));

      fireEvent.blur(screen.getByLabelText('Ranges this rule applies to'), {
        target: { value: 'A1:ZZZ5000000' },
      });

      // The rule kept the ranges it had — the row still names them...
      expect(screen.getByRole('button', { name: /^Edit rule:/ })).toBeTruthy();
      expect(screen.getByText('A1:A9')).toBeTruthy();
      // ...and the panel says why, rather than silently restoring the old value.
      expect(screen.getByRole('alert').textContent).toBeTruthy();
      // The field resynchronises too, instead of keeping the rejected text and
      // reapplying it on the next blur.
      expect((screen.getByLabelText('Ranges this rule applies to') as HTMLInputElement).value)
        .toBe('A1:A9');
    });

    it('creates a custom-formula rule that survives a reload', () => {
      // Adding one with a blank formula produced a rule the parser drops on
      // load: visible now, gone next time the page opened.
      const sheet = createEmptySheet();
      sheet.cells.B2 = '5';
      const content = serializeSheetContent(sheet);
      documentState.current = { content, isDirty: false };

      render(<SheetView page={makePage(content)} />);
      fireEvent.mouseDown(cellAt('B2'));
      openPanel();

      fireEvent.click(screen.getByLabelText('New rule type'));
      fireEvent.click(screen.getByRole('option', { name: /Custom formula/ }));
      fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));

      // Round-trip the rule the panel just made through the parser: a blank
      // formula comes back as no rule at all.
      const written = vi.mocked(serializeSheetContent).mock.calls.at(-1)?.[0];
      expect(written).toBeTruthy();
      expect(parseSheetContent(serializeSheetContent(written!)).conditionalFormats)
        .toHaveLength(1);
    });

    it('is read-only for a viewer', () => {
      lacksEditPermission.current = true;
      const sheet = createEmptySheet();
      const content = serializeSheetContent(sheet);
      documentState.current = { content, isDirty: false };

      render(<SheetView page={makePage(content)} />);
      openPanel();

      expect(screen.getByRole('button', { name: /^Add$/ }).hasAttribute('disabled')).toBe(true);
    });
  });

  it('extends the selection on shift-click', () => {
    // Dragging was the only way to select a range, which makes formatting a
    // wide block of a large sheet impractical. Every other spreadsheet binds
    // shift-click, and the formatting toolbar is only useful with it.
    render(<SheetView page={makePage(contentWith({ A1: 'hello' }))} />);

    fireEvent.mouseDown(cellAt('A1'));
    fireEvent.mouseDown(cellAt('C3'), { shiftKey: true });

    for (const address of ['A1', 'B2', 'C3', 'A3', 'C1']) {
      expect(cellAt(address).getAttribute('aria-selected'), address).toBe('true');
    }
    // ...and nothing beyond the rectangle.
    expect(cellAt('D4').getAttribute('aria-selected')).toBe('false');
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
    expect(cellText('A1')).toBe('hello');
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
