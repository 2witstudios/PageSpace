// @vitest-environment jsdom
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { act } from 'react';
import { mount, unmountAll, click } from '../../test-support/dom';
import { useDocumentManagerStore } from '@/retained/stores/useDocumentManagerStore';
import type { SheetToolsControls } from '@/retained/components/layout/middle-content/page-views/sheet/SheetView';
import { SheetFormulaBar } from '@/retained/components/layout/middle-content/page-views/sheet/components/SheetFormulaBar';

// The retained grid is a dynamic import; the strip and formula bar are what these tests cover.
vi.mock('next/dynamic', () => ({ default: () => () => null }));

const { SheetPageTools } = await import('./sheet-page');

const controls = (overrides: Partial<SheetToolsControls> = {}): SheetToolsControls => ({
  rowCount: 5,
  columnCount: 6,
  canUndo: false,
  canRedo: false,
  onUndo: vi.fn(),
  onRedo: vi.fn(),
  toolbar: <span>Font size</span>,
  ...overrides,
});

beforeEach(() => {
  useDocumentManagerStore.setState({ documents: new Map(), savingDocuments: new Set() });
});

afterEach(unmountAll);

describe('SheetPageTools (IMC-3.3)', () => {
  test('renders a labelled Page tools strip with the sheet size', () => {
    const container = mount(<SheetPageTools controls={controls()} pageId="p1" />);
    const strip = container.querySelector('[role="toolbar"]');
    assert({
      given: 'a sheet of five rows and six columns',
      should: 'render a toolbar named "Page tools" that reads "5 rows · 6 columns"',
      actual: [strip?.getAttribute('aria-label'), strip?.textContent?.includes('5 rows · 6 columns')],
      expected: ['Page tools', true],
    });
  });

  test('shows the save status beside Undo and Redo', () => {
    const container = mount(<SheetPageTools controls={controls()} pageId="p1" />);
    const text = container.textContent ?? '';
    assert({
      given: 'a saved sheet',
      should: 'show Undo, Redo and "Saved" in the strip',
      actual: [container.querySelector('button[aria-label="Undo"]') !== null, container.querySelector('button[aria-label="Redo"]') !== null, text.includes('Saved')],
      expected: [true, true, true],
    });
  });

  test('the default grid leaves Undo disabled', () => {
    const container = mount(<SheetPageTools controls={controls({ canUndo: false })} pageId="p1" />);
    const undo = container.querySelector<HTMLButtonElement>('button[aria-label="Undo"]');
    assert({
      given: 'a sheet with no edits yet',
      should: 'disable Undo',
      actual: undo?.disabled,
      expected: true,
    });
  });

  test('after an edit Undo is enabled and calls the sheet history', () => {
    const onUndo = vi.fn();
    const container = mount(<SheetPageTools controls={controls({ canUndo: true, onUndo })} pageId="p1" />);
    const undo = container.querySelector<HTMLButtonElement>('button[aria-label="Undo"]');
    click(undo as HTMLElement);
    assert({
      given: 'a sheet with an edit to undo',
      should: 'enable Undo and call the history undo when pressed',
      actual: [undo?.disabled, onUndo.mock.calls.length],
      expected: [false, 1],
    });
  });

  test('the formatting tools stay reachable behind More', () => {
    mount(<SheetPageTools controls={controls()} pageId="p1" />);
    const more = document.querySelector<HTMLButtonElement>('button[aria-label="More"]');
    assert({
      given: 'a closed More overflow',
      should: 'not show the formatting tools until More is pressed',
      actual: document.body.textContent?.includes('Font size'),
      expected: false,
    });
    act(() => {
      more?.click();
    });
    assert({
      given: 'More pressed',
      should: 'open the formatting tools in a panel',
      actual: document.body.textContent?.includes('Font size'),
      expected: true,
    });
  });
});

describe('SheetFormulaBar (IMC-3.3)', () => {
  const formulaBar = (selectionAddress: string, formulaValue: string) => (
    <SheetFormulaBar
      isRange={false}
      selectionAddress={selectionAddress}
      currentDisplay=""
      isReadOnly={false}
      onAddRow={vi.fn()}
      onAddColumn={vi.fn()}
      formulaInputRef={{ current: null }}
      formulaValue={formulaValue}
      onFormulaFocus={vi.fn()}
      onFormulaBlur={vi.fn()}
      onFormulaChange={vi.fn()}
      onFormulaKeyDown={vi.fn()}
      driveId="d1"
      mention={{ isOpen: false, position: null, query: '', onSelect: vi.fn(), onClose: vi.fn() }}
    />
  );

  test('labels the selected cell and its formula as Cell and Formula', () => {
    const container = mount(formulaBar('E4', '=C4*12*(1-D4)'));
    const cell = container.querySelector<HTMLInputElement>('input[aria-label="Cell"]');
    const formula = container.querySelector<HTMLInputElement>('input[aria-label="Formula"]');
    assert({
      given: 'E4 selected with a formula in it',
      should: 'render the address in a read-only Cell input and the formula in a Formula input',
      actual: [cell?.value, cell?.readOnly, formula?.value],
      expected: ['E4', true, '=C4*12*(1-D4)'],
    });
  });
});
