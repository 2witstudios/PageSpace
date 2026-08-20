import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import {
  createEmptySheet,
  serializeSheetContent,
  setCellFormats,
  setColumnWidth,
  evaluateSheet,
  encodeCellAddress,
  numberFormatToExcelCode,
  type SheetData,
} from '../sheets/sheet';
import { renderSheetPage } from '../publish/render-sheet-page';
import { generateExcel, type TypedSheetExport } from '../content/export-utils';

/**
 * The grid, the published page and the XLSX export all read the same
 * `SheetEvaluation`. These tests hold them to that: a formatted number must
 * read the same in all three, and formatting must not become an injection
 * vector on the published page.
 */

const typedExportFor = (sheet: SheetData): TypedSheetExport => {
  const evaluation = evaluateSheet(sheet);
  return {
    values: evaluation.display.map((row, rowIndex) =>
      row.map((_, columnIndex) => {
        const cell = evaluation.byAddress[encodeCellAddress(rowIndex, columnIndex)];
        return cell?.error ? cell.display : cell?.value;
      })
    ),
    numberFormats: evaluation.display.map((row, rowIndex) =>
      row.map((_, columnIndex) => {
        const cell = evaluation.byAddress[encodeCellAddress(rowIndex, columnIndex)];
        return numberFormatToExcelCode(cell?.format?.number);
      })
    ),
    columnWidths: Array.from({ length: sheet.columnCount }, (_, columnIndex) => {
      const key = encodeCellAddress(0, columnIndex).replace(/\d+$/, '');
      return sheet.columnWidths?.[key];
    }),
  };
};

const formattedSheet = (): SheetData => {
  let sheet = createEmptySheet(3, 3);
  sheet.cells.A1 = 'Revenue';
  sheet.cells.B1 = '1234.5';
  sheet = setCellFormats(sheet, ['A1'], { bold: true, background: '#fef3c7' });
  sheet = setCellFormats(sheet, ['B1'], {
    number: { kind: 'currency', currency: 'USD', decimals: 2 },
  });
  return sheet;
};

describe('published sheet rendering', () => {
  it('carries formatting into the published table', () => {
    const html = renderSheetPage({
      serializedContent: serializeSheetContent(formattedSheet()),
      title: 'Budget',
    });

    expect(html).toContain('font-weight:600');
    expect(html).toContain('background-color:#fef3c7');
    // The formatted value, not the raw number.
    expect(html).toContain('$1,234.50');
  });

  it('renders the same display string the grid shows', () => {
    const sheet = formattedSheet();
    const gridDisplay = evaluateSheet(sheet).byAddress.B1?.display;
    const html = renderSheetPage({
      serializedContent: serializeSheetContent(sheet),
      title: 'Budget',
    });

    expect(gridDisplay).toBe('$1,234.50');
    expect(html).toContain(gridDisplay!);
  });

  it('does not emit a hostile color into the style attribute', () => {
    // The format is rejected on parse; this asserts the end-to-end outcome,
    // since this document is served with script-src 'none' but still honours
    // inline styles.
    const hostile = [
      '#%PAGESPACE_SHEETDOC v1',
      '',
      '[[sheets]]',
      'name = "Sheet1"',
      'order = 0',
      '',
      '[sheets.meta]',
      'row_count = 3',
      'column_count = 3',
      '',
      '[sheets.cells.A1]',
      'value = "x"',
      'type = "string"',
      'format = { background = "#fff;background-image:url(https://evil.test/x)" }',
      '',
    ].join('\n');

    const html = renderSheetPage({ serializedContent: hostile, title: 'Hostile' });

    expect(html).not.toContain('evil.test');
    expect(html).not.toContain('background-image');
  });

  it('keeps rendering an unformatted sheet exactly as before', () => {
    const sheet = createEmptySheet(2, 2);
    sheet.cells.A1 = 'plain';

    const html = renderSheetPage({
      serializedContent: serializeSheetContent(sheet),
      title: 'Plain',
    });

    expect(html).toContain('<td>plain</td>');
  });

  it('aligns header styling with the header row when hasHeaders is set', () => {
    let sheet = createEmptySheet(3, 2);
    sheet.cells.A1 = 'Header';
    sheet.cells.A2 = 'Body';
    sheet = setCellFormats(sheet, ['A1'], { bold: true });
    sheet = setCellFormats(sheet, ['A2'], { italic: true });

    const html = renderSheetPage({
      serializedContent: serializeSheetContent(sheet),
      title: 'Headers',
      hasHeaders: true,
    });

    // The bold format belongs to the <th>, the italic to the first body <td>.
    expect(html).toMatch(/<th style="font-weight:600">Header<\/th>/);
    expect(html).toMatch(/<td style="font-style:italic">Body<\/td>/);
  });
});

describe('xlsx export', () => {
  // `cellNF` is required for the number-format code to be restored on read;
  // without it SheetJS drops `z` even though the file carries it.
  const readBack = (buffer: Buffer) => {
    const workbook = XLSX.read(buffer, { type: 'buffer', cellNF: true });
    return workbook.Sheets[workbook.SheetNames[0]];
  };

  it('exports numbers as numbers, not as formatted text', () => {
    const sheet = formattedSheet();
    const evaluation = evaluateSheet(sheet);
    const worksheet = readBack(
      generateExcel(evaluation.display, 'Sheet1', 'Budget', typedExportFor(sheet))
    );

    // Without this the cell arrives as the string "$1,234.50" and nothing in
    // Excel can sum, sort or chart it.
    expect(worksheet.B1?.t).toBe('n');
    expect(worksheet.B1?.v).toBe(1234.5);
  });

  it('carries the number format so Excel shows what the grid shows', () => {
    const sheet = formattedSheet();
    const evaluation = evaluateSheet(sheet);
    const worksheet = readBack(
      generateExcel(evaluation.display, 'Sheet1', 'Budget', typedExportFor(sheet))
    );

    expect(worksheet.B1?.z).toBe('"$"#,##0.00');
    // `w` is what a spreadsheet application actually shows — the real proof
    // that the export reads the same as the grid.
    expect(worksheet.B1?.w).toBe('$1,234.50');
  });

  it('keeps text cells as text', () => {
    const sheet = formattedSheet();
    const evaluation = evaluateSheet(sheet);
    const worksheet = readBack(
      generateExcel(evaluation.display, 'Sheet1', 'Budget', typedExportFor(sheet))
    );

    expect(worksheet.A1?.t).toBe('s');
    expect(worksheet.A1?.v).toBe('Revenue');
  });

  it('applies an explicit column width', () => {
    let sheet = formattedSheet();
    sheet = setColumnWidth(sheet, 1, 180);
    const evaluation = evaluateSheet(sheet);

    const buffer = generateExcel(evaluation.display, 'Sheet1', 'Budget', typedExportFor(sheet));
    const workbook = XLSX.read(buffer, { type: 'buffer', cellStyles: true });
    const cols = workbook.Sheets[workbook.SheetNames[0]]['!cols'];

    expect(cols?.[1]?.wch).toBe(25);
  });

  it('emits an explicit width for a column with no data in it', () => {
    // `!cols` used to be derived from the populated data width alone, so a
    // configured width for a column past the widest row was silently dropped —
    // and the route sizes `columnWidths` by `columnCount`, which usually
    // exceeds the data width.
    const sheet = createEmptySheet(2, 6);
    sheet.cells.A1 = 'only column A has data';

    const typed = typedExportFor(sheet);
    typed.columnWidths = [undefined, undefined, undefined, undefined, 210];

    const evaluation = evaluateSheet(sheet);
    const buffer = generateExcel(evaluation.display, 'Sheet1', 'Widths', typed);
    const cols = XLSX.read(buffer, { type: 'buffer', cellStyles: true }).Sheets.Sheet1['!cols'];

    expect(cols?.[4]?.wch).toBe(29);
  });

  it('still works without the typed payload', () => {
    const sheet = formattedSheet();
    const evaluation = evaluateSheet(sheet);
    const worksheet = readBack(generateExcel(evaluation.display, 'Sheet1', 'Budget'));

    // The legacy call shape keeps its old behaviour: everything is text.
    expect(worksheet.B1?.v).toBe('$1,234.50');
  });

  it('exports a formula cell as its computed number', () => {
    let sheet = createEmptySheet(3, 3);
    sheet.cells.A1 = '10';
    sheet.cells.A2 = '=A1*3';
    sheet = setCellFormats(sheet, ['A2'], { number: { kind: 'number', decimals: 0 } });

    const evaluation = evaluateSheet(sheet);
    const worksheet = readBack(
      generateExcel(evaluation.display, 'Sheet1', 'Calc', typedExportFor(sheet))
    );

    expect(worksheet.A2?.t).toBe('n');
    expect(worksheet.A2?.v).toBe(30);
  });

});
