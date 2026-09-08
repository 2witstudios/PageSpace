/**
 * `format_sheet` / `set_conditional_format` render as a formatting card, not
 * as the address→value table `edit_sheet_cells` uses (formatting has no
 * values). The card carries the op/region/rule count, the ranges touched, and
 * one swatch per distinct colour, so a person sees what changed without
 * opening the sheet.
 */
import { describe, it, expect, vi } from 'vitest';
import { isValidElement } from 'react';
import { render } from '@testing-library/react';
import { toolRenderers } from '../registry';
import { SheetFormatRenderer } from '../SheetFormatRenderer';
import { SheetEditRenderer } from '../SheetEditRenderer';

vi.mock('@/hooks/usePageNavigation', () => ({
  usePageNavigation: () => ({ navigateToPage: vi.fn() }),
}));

const renderTool = (
  toolName: 'format_sheet' | 'set_conditional_format',
  parsedInput: Record<string, unknown> | null,
  parsedOutput: Record<string, unknown>,
) =>
  toolRenderers[toolName]({
    toolName,
    parsedInput,
    parsedOutput,
    output: parsedOutput,
  } as Parameters<(typeof toolRenderers)[typeof toolName]>[0]);

describe('format_sheet renderer', () => {
  const input = {
    regions: [
      {
        name: 'Budget',
        range: 'A1:D',
        headerRows: 1,
        columns: [{ column: 'C', role: 'currency', currency: 'USD' }],
        totalRows: [40],
        theme: 'blue',
      },
    ],
    ops: [
      { op: 'setFormat', range: 'B2:B9', format: { background: '#FFF' } },
      { op: 'setFormat', range: 'E1', format: { background: '#ffffff', color: '#b91c1c' } },
      { op: 'columnWidth', column: 'a', width: 140 },
    ],
  };
  const output = {
    success: true,
    pageId: 'page-1',
    title: 'Q3 Budget',
    regionsApplied: 1,
    opsApplied: 3,
    cellsFormatted: 9,
    message: 'Formatted "Q3 Budget": 1 region(s) declared, 3 op(s) applied, 9 cell(s) restyled.',
  };

  it('uses the formatting card, not the cell-value table', () => {
    const element = renderTool('format_sheet', input, output);
    expect(isValidElement(element) && element.type).toBe(SheetFormatRenderer);
    expect(isValidElement(element) && element.type).not.toBe(SheetEditRenderer);
  });

  it('shows the counts, the ranges touched, and a swatch per DISTINCT colour', () => {
    const { getByText, getAllByTestId, getByTestId } = render(<>{renderTool('format_sheet', input, output)}</>);
    expect(getByText('Q3 Budget')).toBeTruthy();
    expect(getByText('1 region · 3 ops · 9 cells')).toBeTruthy();

    expect(getAllByTestId('sheet-format-region')).toHaveLength(1);
    expect(getAllByTestId('sheet-format-op')).toHaveLength(3);
    expect(getByText('A1:D')).toBeTruthy();
    expect(getByText('B2:B9')).toBeTruthy();
    expect(getByText('column A 140px')).toBeTruthy();
    expect(getByText(/C currency USD/)).toBeTruthy();
    expect(getByText(/total 40/)).toBeTruthy();

    // `#FFF` and `#ffffff` are ONE colour; the theme hue and the red text are
    // the other two. Four colour mentions, three swatches.
    expect(getByTestId('sheet-format-swatches').querySelectorAll('span')).toHaveLength(3);
  });

  it('falls through to the generic envelope on a refusal', () => {
    const refusal = { success: false, error: 'invalid_range', message: 'Nothing was applied.', suggestion: 'Fix op 0.' };
    expect(renderTool('format_sheet', input, refusal)).toBeNull();
  });
});

describe('set_conditional_format renderer', () => {
  const input = {
    rules: [
      { kind: 'cell', ranges: ['C2:C40'], operator: 'greaterThan', value: 1000, format: { background: '#dcfce7' } },
      { kind: 'colorScale', ranges: ['D2:D40'], min: { type: 'min', color: '#fee2e2' }, max: { type: 'max', color: '#dcfce7' } },
      { kind: 'dataBar', ranges: ['E2:E40'], color: '#3b82f6' },
      { kind: 'formula', ranges: ['A2:A40'], formula: '=C2>AVERAGE(C2:C40)', format: { color: '#b91c1c' } },
    ],
    removeRuleIds: ['rule-old'],
  };
  const output = {
    success: true,
    pageId: 'page-1',
    title: 'Q3 Budget',
    added: 4,
    removed: 1,
    ruleIds: ['r1', 'r2', 'r3', 'r4'],
  };

  it('uses the formatting card', () => {
    const element = renderTool('set_conditional_format', input, output);
    expect(isValidElement(element) && element.type).toBe(SheetFormatRenderer);
  });

  it('lists every rule with its range, the removed id, and the distinct colours', () => {
    const { getAllByTestId, getByText, getByTestId } = render(<>{renderTool('set_conditional_format', input, output)}</>);
    expect(getAllByTestId('sheet-format-rule')).toHaveLength(4);
    expect(getAllByTestId('sheet-format-removed')).toHaveLength(1);
    expect(getByText('4 rules added · 1 removed')).toBeTruthy();
    expect(getByText('C2:C40 · greaterThan 1000')).toBeTruthy();
    expect(getByText('A2:A40 · =C2>AVERAGE(C2:C40)')).toBeTruthy();
    expect(getByText('rule-old')).toBeTruthy();
    // #dcfce7 appears twice (cell rule + scale max) — one swatch.
    expect(getByTestId('sheet-format-swatches').querySelectorAll('span')).toHaveLength(4);
  });

  it('given nothing to show, says so instead of an empty card', () => {
    const { getByText } = render(
      <>{renderTool('set_conditional_format', { rules: [] }, { success: true, title: 'Q3 Budget', added: 0, removed: 0, message: 'Every rule in this call is already on "Q3 Budget"; nothing was added.' })}</>,
    );
    expect(getByText(/nothing was added/)).toBeTruthy();
  });
});
