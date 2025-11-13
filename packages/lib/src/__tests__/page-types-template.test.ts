import { describe, it, expect } from 'vitest';
import { getDefaultContent, PageType } from '../index';
import { parseSheetDocString, SHEETDOC_MAGIC } from '../sheet';

describe('Sheet Default Template', () => {
  it('should generate a TOML template with example data for SHEET pages', () => {
    const defaultContent = getDefaultContent(PageType.SHEET);

    // Verify it's a string (SheetDoc format)
    expect(typeof defaultContent).toBe('string');

    // Verify it starts with SheetDoc magic header
    expect(defaultContent.trimStart().startsWith(SHEETDOC_MAGIC)).toBe(true);

    // Parse the SheetDoc
    const sheetDoc = parseSheetDocString(defaultContent);

    // Verify basic structure
    expect(sheetDoc.sheets).toBeDefined();
    expect(sheetDoc.sheets.length).toBeGreaterThan(0);

    const sheet = sheetDoc.sheets[0];

    // Verify template has example headers
    expect(sheet.cells.A1?.value).toBe('Item');
    expect(sheet.cells.B1?.value).toBe('Quantity');
    expect(sheet.cells.C1?.value).toBe('Price');
    expect(sheet.cells.D1?.value).toBe('Total');

    // Verify template has example data
    expect(sheet.cells.A2?.value).toBe('Product A');
    expect(sheet.cells.B2?.value).toBe(10);
    expect(sheet.cells.C2?.value).toBe(25.5);

    // Verify template has formulas
    expect(sheet.cells.D2?.formula).toBe('=B2*C2');
    expect(sheet.cells.D3?.formula).toBe('=B3*C3');
    expect(sheet.cells.D5?.formula).toBe('=SUM(D2:D3)');

    // Verify computed values are present
    expect(sheet.cells.D2?.value).toBe(255); // 10 * 25.5
    expect(sheet.cells.D3?.value).toBe(210); // 5 * 42
    expect(sheet.cells.D5?.value).toBe(465); // sum of above

    // Verify dependencies are computed
    expect(sheet.dependencies.D2?.dependsOn).toContain('B2');
    expect(sheet.dependencies.D2?.dependsOn).toContain('C2');
    expect(sheet.dependencies.D5?.dependsOn).toContain('D2');
    expect(sheet.dependencies.D5?.dependsOn).toContain('D3');
  });

  it('should be valid SheetDoc format that AI can understand', () => {
    const defaultContent = getDefaultContent(PageType.SHEET);

    // The template should include key sections that help AI understand the format
    expect(defaultContent).toContain('[sheets.meta]');
    expect(defaultContent).toContain('row_count');
    expect(defaultContent).toContain('column_count');
    expect(defaultContent).toContain('[sheets.cells.');
    expect(defaultContent).toContain('formula =');
    expect(defaultContent).toContain('value =');
    expect(defaultContent).toContain('[sheets.dependencies.');
    expect(defaultContent).toContain('depends_on');
  });
});
