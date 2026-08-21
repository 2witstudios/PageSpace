import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { createEmptySheet, serializeSheetContent } from '@pagespace/lib/sheets/sheet';

/**
 * Virtualization and the editor anchor.
 *
 * jsdom reports every element as zero-sized, which would make a "does it
 * virtualize?" assertion pass no matter what the grid does — a zero-height
 * viewport renders almost nothing whether the grid is windowed or not. So the
 * scroll container is given real dimensions here; without that stub these tests
 * are decorative.
 */

const BODY_WIDTH = 800;
const BODY_HEIGHT = 400;

vi.mock('@/hooks/useDocument', () => ({
  useDocument: () => ({
    document: { content: documentContent.current, isDirty: false },
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
vi.mock('../hooks/useSheetPermissions', () => ({ useSheetPermissions: () => false }));
vi.mock('@/hooks/useSocket', () => ({ useSocket: () => null }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
vi.mock('@/hooks/usePageTree', () => ({ usePageTree: () => ({ tree: [] }) }));
vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/stores/useEditingSession', () => ({ useEditingSession: vi.fn() }));
// `handleValueChange` forwards to `onValueChange`, as the real hook does. A
// `vi.fn()` here would swallow every keystroke and the edit-survives-scroll
// assertion below would be testing the mock rather than the editor.
vi.mock('@/hooks/useSuggestion', () => ({
  useSuggestion: ({ onValueChange }: { onValueChange: (value: string) => void }) => ({
    handleValueChange: onValueChange,
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
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import SheetView from '../SheetView';

const documentContent = { current: '' };

type TestPage = React.ComponentProps<typeof SheetView>['page'];
const makePage = (content: string): TestPage =>
  ({ id: 'p1', title: 'Big', driveId: 'd1', parentId: null, type: 'SHEET', content }) as unknown as TestPage;

const bigSheetContent = (rows: number, columns: number): string => {
  const sheet = createEmptySheet();
  sheet.rowCount = rows;
  sheet.columnCount = columns;
  sheet.cells.A1 = 'top-left';
  return serializeSheetContent(sheet);
};

/** The element the grid actually scrolls. */
const scroller = (): HTMLElement => {
  const element = document.querySelector('[data-sheet-scroller]');
  if (!element) throw new Error('scroll container not rendered');
  return element as HTMLElement;
};

/** Scroll the body and let the rAF-coalesced measurement land. */
const scrollBodyTo = async (top: number, left = 0) => {
  const element = scroller();
  element.scrollTop = top;
  element.scrollLeft = left;
  await act(async () => {
    fireEvent.scroll(element);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
};

const renderedAddresses = (): string[] =>
  Array.from(document.querySelectorAll('[data-cell]')).map(
    (element) => element.getAttribute('data-cell') as string,
  );

let originalRect: typeof HTMLElement.prototype.getBoundingClientRect;

beforeEach(() => {
  originalRect = HTMLElement.prototype.getBoundingClientRect;

  // Only the scroll container needs a size; everything else can stay at zero.
  const sized = (element: HTMLElement) => element.hasAttribute('data-sheet-scroller');

  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return sized(this) ? BODY_WIDTH : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return sized(this) ? BODY_HEIGHT : 0;
    },
  });
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    return sized(this)
      ? ({ left: 48, top: 32, width: BODY_WIDTH, height: BODY_HEIGHT, right: 848, bottom: 432, x: 48, y: 32, toJSON: () => ({}) } as DOMRect)
      : ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
  };
});

afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = originalRect;
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
  Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
});

describe('grid virtualization', () => {
  beforeEach(() => {
    documentContent.current = bigSheetContent(10_000, 60);
  });

  it('renders a bounded window of a 10,000-row sheet, not the whole thing', async () => {
    render(<SheetView page={makePage(documentContent.current)} />);
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });

    const cells = renderedAddresses();
    // Positive, or the stub failed and every later assertion is meaningless.
    expect(cells.length).toBeGreaterThan(0);
    // A 400px body at 32px rows is ~13 rows plus overscan; 60 columns at 112px
    // in an 800px body is ~8. Anything near 600,000 means no windowing at all.
    expect(cells.length).toBeLessThan(600);
  });

  it('renders different cells after scrolling', async () => {
    render(<SheetView page={makePage(documentContent.current)} />);
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });

    expect(renderedAddresses()).toContain('A1');

    await scrollBodyTo(32 * 500);

    const after = renderedAddresses();
    expect(after).not.toContain('A1');
    // Row 501 sits at the top of the window after scrolling 500 rows down.
    expect(after.some((address) => /^A(49[0-9]|5[0-9][0-9])$/.test(address))).toBe(true);
  });

  it('keeps the total scrollable height, so the scrollbar reflects the whole sheet', async () => {
    render(<SheetView page={makePage(documentContent.current)} />);
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });

    const spacer = scroller().firstElementChild as HTMLElement;
    expect(spacer.style.height).toBe(`${10_000 * 32}px`);
  });
});

describe('editing across a scroll', () => {
  beforeEach(() => {
    documentContent.current = bigSheetContent(10_000, 60);
  });

  it('does not cancel an in-progress edit when its cell scrolls out of view', async () => {
    // The defect this replaces: the editor's rectangle was measured from the
    // cell's DOM node, and a missing node was treated as "cell no longer
    // visible, cancel the edit" — so scrolling while editing silently threw the
    // user's typing away.
    render(<SheetView page={makePage(documentContent.current)} />);
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });

    const cell = document.querySelector('[data-cell="A1"]') as HTMLElement;
    fireEvent.doubleClick(cell);

    const editor = await screen.findByLabelText('Edit cell value');
    fireEvent.change(editor, { target: { value: 'still here' } });

    await scrollBodyTo(32 * 400);

    // A1 is long gone from the DOM...
    expect(document.querySelector('[data-cell="A1"]')).toBeNull();
    // ...but the edit survived it.
    const stillOpen = screen.getByLabelText('Edit cell value') as HTMLInputElement;
    expect(stillOpen.value).toBe('still here');
  });
});
