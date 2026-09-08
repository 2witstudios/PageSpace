/**
 * `format_sheet` / `set_conditional_format` render as a formatting card: the
 * op/region/rule counts, the ranges touched, and one swatch per distinct
 * colour, so a person sees what changed without opening the sheet.
 */
import { describe, it, expect, vi } from 'vitest';
import { isValidElement } from 'react';
import { render } from '@testing-library/react';
import { toolRenderers, type ToolRenderContext } from '../registry';
import { SheetFormatRenderer } from '../SheetFormatRenderer';

vi.mock('@/hooks/usePageNavigation', () => ({
  usePageNavigation: () => ({ navigateToPage: vi.fn() }),
}));

const renderTool = (
  toolName: 'format_sheet' | 'set_conditional_format',
  parsedInput: Record<string, unknown> | null,
  parsedOutput: Record<string, unknown>,
) => toolRenderers[toolName]({ toolName, parsedInput, parsedOutput, output: parsedOutput } as ToolRenderContext);

const swatchCount = (root: HTMLElement) => root.querySelectorAll('[data-testid="sheet-format-swatches"] span span').length;

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

  it('uses the formatting card', () => {
    const element = renderTool('format_sheet', input, output);
    expect(isValidElement(element) && element.type).toBe(SheetFormatRenderer);
  });

  it('shows the counts, the ranges touched, and a swatch per DISTINCT colour', () => {
    const { container, getByText, getAllByTestId } = render(<>{renderTool('format_sheet', input, output)}</>);
    expect(getByText('Q3 Budget')).toBeTruthy();
    expect(getByText('1 region · 3 ops · 9 cells')).toBeTruthy();

    expect(getAllByTestId('sheet-format-region')).toHaveLength(1);
    expect(getAllByTestId('sheet-format-op')).toHaveLength(3);
    expect(getByText('A1:D')).toBeTruthy();
    expect(getByText('B2:B9')).toBeTruthy();
    expect(getByText('column A 140px')).toBeTruthy();
    expect(getByText(/C currency USD/)).toBeTruthy();
    expect(getByText(/total 40/)).toBeTruthy();

    // `#FFF` and `#ffffff` are ONE colour; the theme's header band and the
    // red text are the other two. Four colour mentions, three swatches.
    expect(swatchCount(container)).toBe(3);
  });

  it('paints the region swatch with the header colour the sheet itself uses, slate when no theme is named', () => {
    // region-format derives the header band from the theme (deep strength)
    // and falls back to slate; the card must show that colour, not a hue the
    // sheet never paints and not nothing.
    const { container } = render(
      <>{renderTool('format_sheet', { regions: [{ range: 'A1:B', theme: 'blue' }, { range: 'D1:E' }] }, { success: true, title: 'S' })}</>,
    );
    const swatches = [...container.querySelectorAll('[data-testid="sheet-format-region"] span[aria-label]')];
    expect(swatches.map((s) => s.getAttribute('aria-label'))).toEqual(['blue', 'slate']);
    expect(swatches.map((s) => (s as HTMLElement).style.backgroundColor)).toEqual(['rgb(29, 78, 216)', 'rgb(51, 65, 85)']);
  });

  it('shows the destructive half of a replaceAll: the regions it removed', () => {
    // A replaceAll keeps only the regions in the call and deletes the rest.
    // The result reports the mode; the card must say so instead of "1 region"
    // as though nothing was taken away — and an EMPTY replaceAll is not an
    // empty card, it is "every region removed".
    const one = render(
      <>{renderTool('format_sheet', { regionMode: 'replaceAll', regions: [{ range: 'A1:B' }] }, { success: true, title: 'S', regionsApplied: 1, regionMode: 'replaceAll' })}</>,
    );
    expect(one.getByText('1 region · other regions removed')).toBeTruthy();
    expect(one.container.querySelector('[data-testid="sheet-format-regions-replaced"]')?.textContent).toContain('Every other region on the tab removed');
    one.unmount();

    const none = render(
      <>{renderTool('format_sheet', { regionMode: 'replaceAll', regions: [] }, { success: true, title: 'S', regionsApplied: 0, regionMode: 'replaceAll' })}</>,
    );
    expect(none.container.querySelector('[data-testid="sheet-format-regions-replaced"]')?.textContent).toContain('Every region on the tab removed');
    expect(none.queryByText('Nothing changed')).toBeNull();
  });

  it('shows a no-op result as unchanged, not as the formatting it would have applied', () => {
    // The store reports a retry (or a bold that was already bold) with
    // nothing written; the result says `changed: false`. The card must not
    // list "1 op" as though something landed.
    const { getByTestId, getByText, queryByTestId } = render(
      <>{renderTool('format_sheet', input, { ...output, changed: false })}</>,
    );
    expect(getByText('already formatted this way')).toBeTruthy();
    expect(getByTestId('sheet-format-empty').textContent).toContain('already had this formatting');
    expect(queryByTestId('sheet-format-op')).toBeNull();
    expect(queryByTestId('sheet-format-region')).toBeNull();
  });

  it("falls through to the generic envelope on the tool's own refusal", () => {
    const refusal = { success: false, error: 'invalid_range', message: 'Nothing was applied.', suggestion: 'Fix op 0.' };
    expect(renderTool('format_sheet', input, refusal)).toBeNull();
  });

  it('falls through on the execute_tool error envelope, which has no success key and unvalidated input', () => {
    // In search exposure the wrapper returns `{ error }` as a normal output
    // with the model's raw parameters as the input. Rendering that as a
    // success card would show a change that never landed — and a region
    // without a range would crash the card.
    const envelope = { error: 'Invalid parameters for "format_sheet": regions[0].range is required.' };
    expect(renderTool('format_sheet', { regions: [{ name: 'no range' }] }, envelope)).toBeNull();
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

  it("lists every rule in the sheet's own words, the removed id, and the distinct colours", () => {
    const { container, getAllByTestId, getByText } = render(<>{renderTool('set_conditional_format', input, output)}</>);
    expect(getAllByTestId('sheet-format-rule')).toHaveLength(4);
    expect(getAllByTestId('sheet-format-removed')).toHaveLength(1);
    expect(getByText('4 rules added · 1 removed')).toBeTruthy();
    // The same wording the sheet's rule panel uses.
    expect(getByText('C2:C40 · is greater than 1000')).toBeTruthy();
    expect(getByText('A2:A40 · =C2>AVERAGE(C2:C40)')).toBeTruthy();
    expect(getByText('rule-old')).toBeTruthy();
    // #dcfce7 appears twice (cell rule + scale max) — one swatch.
    expect(swatchCount(container)).toBe(4);
  });

  it('omits the operands the executor drops, so the card describes the stored rule', () => {
    // isEmpty/isNotEmpty/isError store no operand; only between/notBetween
    // keep value2. The tool warns and drops the rest; the card must not
    // print what was dropped.
    const { getByText, queryByText } = render(
      <>{renderTool(
        'set_conditional_format',
        {
          rules: [
            { kind: 'cell', ranges: ['A1:A9'], operator: 'isEmpty', value: 'stray' },
            { kind: 'cell', ranges: ['B1:B9'], operator: 'lessThan', value: 5, value2: 99 },
            { kind: 'cell', ranges: ['C1:C9'], operator: 'between', value: 1, value2: 10 },
          ],
        },
        { success: true, title: 'S', added: 3, removed: 0 },
      )}</>,
    );
    expect(getByText('A1:A9 · is empty')).toBeTruthy();
    expect(getByText('B1:B9 · is less than 5')).toBeTruthy();
    expect(getByText('C1:C9 · is between 1 and 10')).toBeTruthy();
    expect(queryByText(/stray/)).toBeNull();
    expect(queryByText(/99/)).toBeNull();
  });

  it('labels rules the result reports as already present, instead of showing them as changes', () => {
    // An append that overlaps what is already on the tab lands only the new
    // rules; the result names the rest by index in `skippedDuplicates`. The
    // card must not present those rows as changes.
    const overlapping = {
      success: true,
      title: 'Q3 Budget',
      added: 2,
      removed: 0,
      skippedDuplicates: [
        { index: 0, existingRuleId: 'r-old-1' },
        { index: 2, existingRuleId: 'r-old-3' },
      ],
    };
    const { getAllByTestId, getByText, queryByTestId } = render(
      <>{renderTool('set_conditional_format', { rules: input.rules }, overlapping)}</>,
    );
    expect(getAllByTestId('sheet-format-rule-duplicate')).toHaveLength(2);
    expect(getAllByTestId('sheet-format-rule')).toHaveLength(2);
    expect(getAllByTestId('sheet-format-rule-duplicate')[0].textContent).toContain('already present');
    expect(getByText('2 rules added · 2 already present')).toBeTruthy();
    expect(queryByTestId('sheet-format-removed')).toBeNull();
  });

  it('lists a repeated removeRuleIds entry once, as the executor removes it once', () => {
    const { getAllByTestId, getByText } = render(
      <>{renderTool('set_conditional_format', { removeRuleIds: ['r-1', 'r-1', 'r-2'] }, { success: true, title: 'S', added: 0, removed: 2 })}</>,
    );
    expect(getAllByTestId('sheet-format-removed')).toHaveLength(2);
    expect(getByText('2 removed')).toBeTruthy();
  });

  it('falls through on the execute_tool error envelope even when the input looks well-formed', () => {
    // A read-only agent in search mode gets `{ error: 'not permitted' }` with
    // valid-looking rules as the input; nothing landed, so no card.
    expect(renderTool('set_conditional_format', input, { error: 'Tool "set_conditional_format" is not permitted for this agent.' })).toBeNull();
  });

  it('given nothing to show, says so instead of an empty card', () => {
    const { getByText } = render(
      <>{renderTool('set_conditional_format', { rules: [] }, { success: true, title: 'Q3 Budget', added: 0, removed: 0, message: 'Every rule in this call is already on "Q3 Budget"; nothing was added.' })}</>,
    );
    expect(getByText(/nothing was added/)).toBeTruthy();
  });
});
