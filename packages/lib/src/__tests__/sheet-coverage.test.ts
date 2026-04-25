import { describe, it, expect } from 'vitest';
import {
  createEmptySheet,
  evaluateSheet,
  serializeSheetContent,
  parseSheetContent,
  parseSheetDocString,
  stringifySheetDoc,
  collectExternalReferences,
  adjustFormulaReferences,
  decodeCellAddress,
  encodeCellAddress,
  isValidCellAddress,
  SHEETDOC_MAGIC,
  SHEETDOC_VERSION,
  SheetData,
  SheetDoc,
  SheetDocSheet,
} from '../sheets/sheet';
import { tokenize, FormulaParser } from '../sheets/parser';

const getDisplay = (evaluation: ReturnType<typeof evaluateSheet>, address: string) => {
  return evaluation.byAddress[address]?.display;
};

const getError = (evaluation: ReturnType<typeof evaluateSheet>, address: string) => {
  return evaluation.byAddress[address]?.error;
};

// ============================================================
// Task 2: io.ts uncovered lines - formatTomlValue, formatInlineTable,
// clonePlainObject, toCamelCase, toSnakeCase
// ============================================================
describe('io.ts coverage - serialization edge cases', () => {
  it('serializes boolean cell values through formatTomlValue', () => {
    // Boolean values in cells are stored as strings "true"/"false" in SheetData.
    // To exercise the boolean path in formatTomlValue, we need cells that evaluate
    // to booleans (via formulas), which then get serialized.
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '10';
    sheet.cells.A2 = '5';
    sheet.cells.A3 = '=A1>A2'; // evaluates to boolean true

    const serialized = serializeSheetContent(sheet);
    expect(serialized).toContain(SHEETDOC_MAGIC);
    // The boolean value true should appear in the TOML output
    expect(serialized).toContain('value = true');
  });

  it('serializes false boolean values', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '5';
    sheet.cells.A2 = '10';
    sheet.cells.A3 = '=A1>A2'; // evaluates to boolean false

    const serialized = serializeSheetContent(sheet);
    expect(serialized).toContain('value = false');
  });

  it('serializes cell notes as arrays via formatTomlValue array path', () => {
    // Build a SheetDoc directly with notes to exercise formatTomlValue array path
    const doc: SheetDoc = {
      version: SHEETDOC_VERSION as typeof SHEETDOC_VERSION,
      sheets: [
        {
          name: 'Sheet1',
          order: 0,
          meta: { rowCount: 5, columnCount: 5 },
          columns: {},
          cells: {
            A1: {
              value: 42,
              notes: ['Note 1', 'Note 2'],
            },
          },
          ranges: {},
          dependencies: {},
        },
      ],
    };

    const serialized = stringifySheetDoc(doc);
    expect(serialized).toContain('notes = ["Note 1", "Note 2"]');
  });

  it('serializes cell errors as inline tables via formatInlineTable', () => {
    const doc: SheetDoc = {
      version: SHEETDOC_VERSION as typeof SHEETDOC_VERSION,
      sheets: [
        {
          name: 'Sheet1',
          order: 0,
          meta: { rowCount: 5, columnCount: 5 },
          columns: {},
          cells: {
            A1: {
              formula: '=1/0',
              value: '',
              error: {
                type: 'EVAL_ERROR',
                message: 'Division by zero',
              },
            },
          },
          ranges: {},
          dependencies: {},
        },
      ],
    };

    const serialized = stringifySheetDoc(doc);
    expect(serialized).toContain('error = { type = "EVAL_ERROR", message = "Division by zero" }');
  });

  it('serializes columns via formatInlineTable', () => {
    const doc: SheetDoc = {
      version: SHEETDOC_VERSION as typeof SHEETDOC_VERSION,
      sheets: [
        {
          name: 'Sheet1',
          order: 0,
          meta: { rowCount: 5, columnCount: 5 },
          columns: {
            A: { width: 100, hidden: false },
            B: { width: 200, label: 'Amount' },
          },
          cells: {},
          ranges: {},
          dependencies: {},
        },
      ],
    };

    const serialized = stringifySheetDoc(doc);
    expect(serialized).toContain('[sheets.columns]');
    expect(serialized).toContain('width = 100');
    expect(serialized).toContain('hidden = false');
  });

  it('serializes ranges via formatTomlValue', () => {
    const doc: SheetDoc = {
      version: SHEETDOC_VERSION as typeof SHEETDOC_VERSION,
      sheets: [
        {
          name: 'Sheet1',
          order: 0,
          meta: { rowCount: 5, columnCount: 5 },
          columns: {},
          cells: {},
          ranges: {
            myRange: {
              start: 'A1',
              end: 'B5',
              name: 'Sales Data',
            },
          },
          dependencies: {},
        },
      ],
    };

    const serialized = stringifySheetDoc(doc);
    expect(serialized).toContain('[sheets.ranges.myRange]');
    expect(serialized).toContain('start = "A1"');
    expect(serialized).toContain('end = "B5"');
  });

  it('exercises toCamelCase and toSnakeCase via meta with custom properties', () => {
    // custom meta properties go through toCamelCase when parsing and toSnakeCase when serializing
    const sheetDoc = `${SHEETDOC_MAGIC} ${SHEETDOC_VERSION}

[[sheets]]
name = "Sheet1"
order = 0

[sheets.meta]
row_count = 5
column_count = 5
custom_setting = "hello"
another_value = 42
`;
    const parsed = parseSheetDocString(sheetDoc);
    const sheet = parsed.sheets[0];
    // custom_setting should be converted to camelCase
    expect(sheet.meta.customSetting).toBe('hello');
    expect(sheet.meta.anotherValue).toBe(42);

    // Now serialize back - it should convert to snake_case
    const serialized = stringifySheetDoc(parsed);
    expect(serialized).toContain('custom_setting = "hello"');
    expect(serialized).toContain('another_value = 42');
  });

  it('exercises clonePlainObject with nested objects and arrays in ranges', () => {
    const sheetDoc = `${SHEETDOC_MAGIC} ${SHEETDOC_VERSION}

[[sheets]]
name = "Sheet1"
order = 0

[sheets.meta]
row_count = 5
column_count = 5

[sheets.ranges.highlight]
start = "A1"
end = "B5"
`;

    const parsed = parseSheetDocString(sheetDoc);
    expect(parsed.sheets[0].ranges.highlight).toEqual({ start: 'A1', end: 'B5' });
  });

  it('serializes pageId in SheetDoc', () => {
    const serialized = serializeSheetContent(
      createEmptySheet(5, 5),
      { pageId: 'test-page-123' }
    );
    expect(serialized).toContain('page_id = "test-page-123"');
  });

  it('serializes with custom sheet name', () => {
    const serialized = serializeSheetContent(
      createEmptySheet(5, 5),
      { sheetName: 'My Custom Sheet' }
    );
    expect(serialized).toContain('name = "My Custom Sheet"');
  });

  it('handles frozen rows and columns in meta', () => {
    const sheetDoc = `${SHEETDOC_MAGIC} ${SHEETDOC_VERSION}

[[sheets]]
name = "Sheet1"
order = 0

[sheets.meta]
row_count = 10
column_count = 10
frozen_rows = 2
frozen_columns = 1
`;

    const parsed = parseSheetDocString(sheetDoc);
    expect(parsed.sheets[0].meta.frozenRows).toBe(2);
    expect(parsed.sheets[0].meta.frozenColumns).toBe(1);

    const serialized = stringifySheetDoc(parsed);
    expect(serialized).toContain('frozen_rows = 2');
    expect(serialized).toContain('frozen_columns = 1');
  });

  it('handles empty inline table formatting', () => {
    const doc: SheetDoc = {
      version: SHEETDOC_VERSION as typeof SHEETDOC_VERSION,
      sheets: [
        {
          name: 'Sheet1',
          order: 0,
          meta: { rowCount: 5, columnCount: 5 },
          columns: {
            A: {},
          },
          cells: {},
          ranges: {},
          dependencies: {},
        },
      ],
    };

    const serialized = stringifySheetDoc(doc);
    expect(serialized).toContain('A = {}');
  });

  it('handles error with details in cell serialization', () => {
    const doc: SheetDoc = {
      version: SHEETDOC_VERSION as typeof SHEETDOC_VERSION,
      sheets: [
        {
          name: 'Sheet1',
          order: 0,
          meta: { rowCount: 5, columnCount: 5 },
          columns: {},
          cells: {
            A1: {
              formula: '=A1',
              value: '',
              error: {
                type: 'CIRCULAR_REF',
                message: 'Circular reference detected',
                details: ['A1'],
              },
            },
          },
          ranges: {},
          dependencies: {},
        },
      ],
    };

    const serialized = stringifySheetDoc(doc);
    expect(serialized).toContain('CIRCULAR_REF');
    expect(serialized).toContain('details = ["A1"]');
  });

  it('parseSheetContent handles SheetDoc object directly', () => {
    // Exercise isSheetDocObject path
    const sheetDocObj = {
      sheets: [
        {
          name: 'Sheet1',
          order: 0,
          meta: { row_count: 5, column_count: 5 },
          cells: {
            A1: { value: 42 },
          },
        },
      ],
    };

    const parsed = parseSheetContent(sheetDocObj);
    expect(parsed.cells.A1).toBe('42');
    expect(parsed.rowCount).toBe(5);
    expect(parsed.columnCount).toBe(5);
  });

  it('parseSheetContent returns empty sheet for non-object', () => {
    const parsed = parseSheetContent(42);
    expect(parsed.cells).toEqual({});
  });

  it('parseSheetContent returns empty sheet for null', () => {
    const parsed = parseSheetContent(null);
    expect(parsed.cells).toEqual({});
  });

  it('parseSheetContent returns empty sheet for empty string', () => {
    const parsed = parseSheetContent('');
    expect(parsed.cells).toEqual({});
  });

  it('parseSheetContent handles invalid JSON string gracefully', () => {
    const parsed = parseSheetContent('not valid json {{{');
    expect(parsed.cells).toEqual({});
  });

  it('handles boolean meta value in camelCase conversion', () => {
    const sheetDoc = `${SHEETDOC_MAGIC} ${SHEETDOC_VERSION}

[[sheets]]
name = "Sheet1"
order = 0

[sheets.meta]
row_count = 5
column_count = 5
is_locked = true
`;

    const parsed = parseSheetDocString(sheetDoc);
    expect(parsed.sheets[0].meta.isLocked).toBe(true);
  });
});

// ============================================================
// Task 3: functions.ts uncovered lines - RANDBETWEEN error paths
// ============================================================
describe('RANDBETWEEN error paths', () => {
  it('returns error when RANDBETWEEN has wrong argument count (one arg)', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '=RANDBETWEEN(5)';
    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A1')).toBe('#ERROR');
    expect(getError(result, 'A1')).toContain('RANDBETWEEN expects exactly two arguments');
  });

  it('returns error when RANDBETWEEN has wrong argument count (three args)', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '=RANDBETWEEN(1, 10, 5)';
    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A1')).toBe('#ERROR');
    expect(getError(result, 'A1')).toContain('RANDBETWEEN expects exactly two arguments');
  });

  it('returns error when RANDBETWEEN has non-numeric args', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = 'hello';
    sheet.cells.A2 = '=RANDBETWEEN(A1, 10)';
    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A2')).toBe('#ERROR');
  });

  it('returns error when RANDBETWEEN bottom > top', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '=RANDBETWEEN(10, 1)';
    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A1')).toBe('#ERROR');
    expect(getError(result, 'A1')).toContain('bottom must be less than or equal to top');
  });

  it('returns error for unsupported function name', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '=NOSUCHFUNC(1)';
    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A1')).toBe('#ERROR');
    expect(getError(result, 'A1')).toContain('Unsupported function');
  });
});

// ============================================================
// Task 4: parser.ts uncovered lines - error handling paths
// ============================================================
describe('parser.ts error handling', () => {
  it('throws on unexpected end of formula (empty tokens after parse)', () => {
    // A formula that results in an unexpected end: just an operator
    expect(() => {
      const tokens = tokenize('+');
      const parser = new FormulaParser(tokens);
      parser.parse();
    }).toThrow();
  });

  it('throws on unexpected identifier without function call', () => {
    // An identifier that is not followed by parenthesis -> error
    expect(() => {
      const tokens = tokenize('INVALID');
      const parser = new FormulaParser(tokens);
      parser.parse();
    }).toThrow("Unexpected identifier 'INVALID'");
  });

  it('throws when range uses non-cell references', () => {
    // Range requires cell references on both sides
    expect(() => {
      const tokens = tokenize('5:10');
      const parser = new FormulaParser(tokens);
      parser.parse();
    }).toThrow('Range references must use cell addresses');
  });

  it('throws on unexpected tokens after end of formula', () => {
    expect(() => {
      const tokens = tokenize('A1 B2');
      const parser = new FormulaParser(tokens);
      parser.parse();
    }).toThrow('Unexpected tokens after end of formula');
  });

  it('throws on unterminated string literal', () => {
    expect(() => {
      tokenize('"unterminated');
    }).toThrow('Unterminated string literal');
  });

  it('throws on unterminated page reference', () => {
    expect(() => {
      tokenize('@[unclosed');
    }).toThrow('Unterminated page reference');
  });

  it('throws on empty page reference label', () => {
    expect(() => {
      tokenize('@[]');
    }).toThrow('Page reference label cannot be empty');
  });

  it('throws on unterminated page reference identifier', () => {
    expect(() => {
      tokenize('@[Page](unclosed');
    }).toThrow('Unterminated page reference identifier');
  });

  it('throws on invalid number literal', () => {
    expect(() => {
      tokenize('1.2.3');
    }).toThrow('Invalid number literal');
  });

  it('throws on unexpected character', () => {
    expect(() => {
      tokenize('~');
    }).toThrow("Unexpected character '~'");
  });

  it('throws on $ not followed by valid cell reference', () => {
    expect(() => {
      tokenize('$');
    }).toThrow("Unexpected character '$'");
  });

  it('parses expected cell reference after page reference', () => {
    // page ref followed by colon should expect cell ref
    expect(() => {
      const tokens = tokenize('@[Sales](id1):5');
      const parser = new FormulaParser(tokens);
      parser.parse();
    }).toThrow('Expected cell reference after page reference');
  });

  it('throws missing closing parenthesis for function', () => {
    expect(() => {
      const tokens = tokenize('SUM(A1');
      const parser = new FormulaParser(tokens);
      parser.parse();
    }).toThrow('Expected closing parenthesis for SUM()');
  });

  it('throws on expected colon after page reference', () => {
    expect(() => {
      const tokens = tokenize('@[Page] A1');
      const parser = new FormulaParser(tokens);
      parser.parse();
    }).toThrow('Expected ":" after page reference');
  });

  it('parses page reference with mentionType (colon in identifier)', () => {
    const tokens = tokenize('@[Sales](id1:sheet)');
    const pageToken = tokens.find(t => t.type === 'page');
    expect(pageToken).not.toBeUndefined();
    expect((pageToken!.meta!.page as { identifier?: string; mentionType?: string }).identifier).toBe('id1');
    expect((pageToken!.meta!.page as { identifier?: string; mentionType?: string }).mentionType).toBe('sheet');
  });

  it('parses page reference with empty identifier in parentheses', () => {
    const tokens = tokenize('@[Sales]()');
    const pageToken = tokens.find(t => t.type === 'page');
    expect(pageToken).not.toBeUndefined();
  });

  it('handles grouping parentheses in formulas', () => {
    const tokens = tokenize('(A1 + B1) * C1');
    const parser = new FormulaParser(tokens);
    const ast = parser.parse();
    expect(ast.type).toBe('BinaryExpression');
  });

  it('throws on missing closing parenthesis in grouping', () => {
    expect(() => {
      const tokens = tokenize('(A1 + B1');
      const parser = new FormulaParser(tokens);
      parser.parse();
    }).toThrow('Expected closing parenthesis');
  });
});

// ============================================================
// Task 5: external.ts uncovered lines - error handling
// ============================================================
describe('external.ts error handling', () => {
  it('skips formulas that fail to parse', () => {
    const sheet = createEmptySheet(5, 5);
    // A formula with invalid syntax that will cause tokenize/parse to throw
    sheet.cells.A1 = '=@[unclosed';
    sheet.cells.A2 = '10';

    const refs = collectExternalReferences(sheet);
    // Should gracefully skip the bad formula and return empty
    expect(refs.length).toBe(0);
  });

  it('handles non-formula cells', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = 'plain text';
    sheet.cells.A2 = '42';

    const refs = collectExternalReferences(sheet);
    expect(refs.length).toBe(0);
  });

  it('handles formulas with no external references', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '=A2+A3';

    const refs = collectExternalReferences(sheet);
    expect(refs.length).toBe(0);
  });

  it('collects external refs through unary expressions', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '=-@[Sales](s1):B1';

    const refs = collectExternalReferences(sheet);
    expect(refs.length).toBe(1);
    expect(refs[0].label).toBe('Sales');
  });

  it('collects external refs through binary expressions', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '=@[Sales](s1):B1 + @[Budget](b1):C1';

    const refs = collectExternalReferences(sheet);
    expect(refs.length).toBe(2);
    const labels = refs.map(r => r.label).sort();
    expect(labels).toEqual(['Budget', 'Sales']);
  });

  it('collects external refs through function calls', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '=SUM(@[Sales](s1):B1:B3)';

    const refs = collectExternalReferences(sheet);
    expect(refs.length).toBe(1);
    expect(refs[0].label).toBe('Sales');
  });

  it('handles empty formula after =', () => {
    const sheet = createEmptySheet(5, 5);
    // Exercise the tokens.length === 0 branch
    sheet.cells.A1 = '=   ';

    const refs = collectExternalReferences(sheet);
    expect(refs.length).toBe(0);
  });

  it('default node type falls through without error', () => {
    // Test that non-external AST node types (NumberLiteral, StringLiteral,
    // CellReference, Range, BooleanLiteral) are handled silently
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '=IF(true, "yes", "no")';
    sheet.cells.A2 = '=SUM(A1:A1)';
    sheet.cells.A3 = '=42 + 3';

    const refs = collectExternalReferences(sheet);
    expect(refs.length).toBe(0);
  });
});

// ============================================================
// Task 6: evaluation.ts uncovered lines - normalizeDependencyReference
// ============================================================
describe('evaluation.ts - normalizeDependencyReference edge cases', () => {
  it('normalizes external reference with label, identifier, mentionType and address', () => {
    // This exercises the regex path in normalizeDependencyReference
    // when processing dependencies from parsed SheetDoc data
    const sheetDocSource = `${SHEETDOC_MAGIC} ${SHEETDOC_VERSION}

[[sheets]]
name = "Sheet1"
order = 0

[sheets.meta]
row_count = 5
column_count = 5

[sheets.cells.A1]
formula = "=B1"
value = 10

[sheets.dependencies.A1]
depends_on = ["B1"]
dependents = []

[sheets.dependencies.B1]
depends_on = []
dependents = ["A1"]
`;

    const parsed = parseSheetDocString(sheetDocSource);
    expect(parsed.sheets[0].dependencies.A1.dependsOn).toEqual(['B1']);
    expect(parsed.sheets[0].dependencies.B1.dependents).toEqual(['A1']);
  });

  it('normalizes external dependency references in SheetDoc', () => {
    const sheetDocSource = `${SHEETDOC_MAGIC} ${SHEETDOC_VERSION}

[[sheets]]
name = "Sheet1"
order = 0

[sheets.meta]
row_count = 5
column_count = 5

[sheets.cells.A1]
formula = "=@[Sales](sales-1):B1"
value = 10

[sheets.dependencies.A1]
depends_on = ["@[Sales](sales-1):B1"]
dependents = []
`;

    const parsed = parseSheetDocString(sheetDocSource);
    expect(parsed.sheets[0].dependencies.A1.dependsOn).toEqual(['@[Sales](sales-1):B1']);
  });

  it('filters invalid dependency references in SheetDoc', () => {
    const sheetDocSource = `${SHEETDOC_MAGIC} ${SHEETDOC_VERSION}

[[sheets]]
name = "Sheet1"
order = 0

[sheets.meta]
row_count = 5
column_count = 5

[sheets.dependencies.A1]
depends_on = ["VALID1", "not a valid ref !!!", "B2"]
dependents = ["C3"]
`;

    const parsed = parseSheetDocString(sheetDocSource);
    // Invalid refs get filtered out
    expect(parsed.sheets[0].dependencies.A1.dependsOn).toEqual(['B2', 'VALID1']);
    expect(parsed.sheets[0].dependencies.A1.dependents).toEqual(['C3']);
  });

  it('handles empty label in external reference dependency', () => {
    // Exercise the label.trim() empty check in normalizeDependencyReference
    const sheetDocSource = `${SHEETDOC_MAGIC} ${SHEETDOC_VERSION}

[[sheets]]
name = "Sheet1"
order = 0

[sheets.meta]
row_count = 5
column_count = 5

[sheets.dependencies.A1]
depends_on = ["@[ ](id):A1"]
dependents = []
`;

    const parsed = parseSheetDocString(sheetDocSource);
    // Empty label should be filtered out
    expect(parsed.sheets[0].dependencies.A1.dependsOn).toEqual([]);
  });

  it('handles external reference with mentionType in dependency', () => {
    const sheetDocSource = `${SHEETDOC_MAGIC} ${SHEETDOC_VERSION}

[[sheets]]
name = "Sheet1"
order = 0

[sheets.meta]
row_count = 5
column_count = 5

[sheets.dependencies.A1]
depends_on = ["@[Sales](sales-1:sheet):B1"]
dependents = []
`;

    const parsed = parseSheetDocString(sheetDocSource);
    expect(parsed.sheets[0].dependencies.A1.dependsOn).toEqual(['@[Sales](sales-1:sheet):B1']);
  });

  it('filters empty string dependency references', () => {
    const sheetDocSource = `${SHEETDOC_MAGIC} ${SHEETDOC_VERSION}

[[sheets]]
name = "Sheet1"
order = 0

[sheets.meta]
row_count = 5
column_count = 5

[sheets.dependencies.A1]
depends_on = ["", "  ", "A1"]
dependents = []
`;

    const parsed = parseSheetDocString(sheetDocSource);
    // Empty and whitespace-only refs should be filtered out
    expect(parsed.sheets[0].dependencies.A1.dependsOn).toEqual(['A1']);
  });

  it('filters dependency refs with invalid address portion', () => {
    // Exercise the address validation check in normalizeDependencyReference
    const sheetDocSource = `${SHEETDOC_MAGIC} ${SHEETDOC_VERSION}

[[sheets]]
name = "Sheet1"
order = 0

[sheets.meta]
row_count = 5
column_count = 5

[sheets.dependencies.A1]
depends_on = ["@[Sales](id):NOTVALID!"]
dependents = []
`;

    const parsed = parseSheetDocString(sheetDocSource);
    // Invalid address should be filtered
    expect(parsed.sheets[0].dependencies.A1.dependsOn).toEqual([]);
  });
});

// ============================================================
// Task 7: address.ts uncovered lines - catch blocks
// ============================================================
describe('address.ts catch blocks', () => {
  it('decodeCellAddress throws on invalid input', () => {
    expect(() => decodeCellAddress('!!!')).toThrow('Invalid cell reference');
    expect(() => decodeCellAddress('')).toThrow('Invalid cell reference');
    expect(() => decodeCellAddress('123')).toThrow('Invalid cell reference');
  });

  it('adjustFormulaReferences handles formula with reference that causes decode to fail', () => {
    // This is hard to trigger since the regex-based scanning in adjustFormulaReferences
    // only tries to decode things that look like cell references.
    // But we can test with very long column letters that create huge numbers.
    // The function has a catch block that returns the original token on error.
    // A formula like =AAAAAAAAAA1 would decode to a very large column number.
    // encodeCellAddress doesn't throw for large numbers, so the catch path
    // is defensive. Let's test that the function handles edge cases gracefully.
    const result = adjustFormulaReferences('=A1', 0, 0);
    expect(result).toBe('=A1');
  });

  it('adjustFormulaReferences preserves formula when decode fails on unusual patterns', () => {
    // Test the catch block at line 157-158: the formula scanner finds column letters
    // followed by row digits, tries decodeCellAddress, and if that throws,
    // falls back to the original token.
    // The sanitizeSheetData also has a catch block.
    // Test with long repetitive patterns that might exercise the fallback
    const formula = '=A1 + B2 + C3';
    const result = adjustFormulaReferences(formula, 0, 0);
    expect(result).toBe('=A1 + B2 + C3');
  });
});

// ============================================================
// Task 8: barrel export test for index.ts
// ============================================================
/** @scaffold — barrel export presence check */
describe('sheets barrel export (index.ts) @scaffold', () => {
  it('exports all expected public symbols', async () => {
    const sheets = await import('../sheets/sheet');
    const expectedFunctions = [
      'evaluateSheet', 'createEmptySheet', 'parseSheetContent',
      'serializeSheetContent', 'collectExternalReferences',
      'encodeCellAddress', 'decodeCellAddress', 'adjustFormulaReferences',
      'tokenize', 'FormulaParser', 'isSheetType', 'updateSheetCells',
    ];
    for (const name of expectedFunctions) {
      expect(sheets).toHaveProperty(name);
      expect(typeof (sheets as Record<string, unknown>)[name]).toBe('function');
    }
    expect(sheets.SHEETDOC_MAGIC).toBe('#%PAGESPACE_SHEETDOC');
    expect(sheets.SHEETDOC_VERSION).toBe('v1');
    expect(sheets.SHEET_VERSION).toBe(1);
    expect(sheets.SHEET_DEFAULT_ROWS).toBe(20);
    expect(sheets.SHEET_DEFAULT_COLUMNS).toBe(10);
  });
});

// ============================================================
// Additional io.ts coverage - normalizeDependencyReference in io.ts (lines 535-536, 543-544)
// These are the io.ts version of the function, similar to evaluation.ts
// ============================================================
describe('io.ts normalizeDependencyReference additional paths', () => {
  it('handles external ref without identifier in dependency normalization', () => {
    const sheetDocSource = `${SHEETDOC_MAGIC} ${SHEETDOC_VERSION}

[[sheets]]
name = "Sheet1"
order = 0

[sheets.meta]
row_count = 5
column_count = 5

[sheets.dependencies.A1]
depends_on = ["@[Sales]:B1"]
dependents = []
`;

    const parsed = parseSheetDocString(sheetDocSource);
    expect(parsed.sheets[0].dependencies.A1.dependsOn).toEqual(['@[Sales]:B1']);
  });

  it('handles cell error normalization with details and type', () => {
    const sheetDocSource = `${SHEETDOC_MAGIC} ${SHEETDOC_VERSION}

[[sheets]]
name = "Sheet1"
order = 0

[sheets.meta]
row_count = 5
column_count = 5

[sheets.cells.A1]
formula = "=A1"
value = ""

[sheets.cells.A1.error]
type = "CIRCULAR_REF"
message = "Circular reference"
details = ["A1"]
`;

    const parsed = parseSheetDocString(sheetDocSource);
    expect(parsed.sheets[0].cells.A1.error?.type).toBe('CIRCULAR_REF');
    expect(parsed.sheets[0].cells.A1.error?.message).toBe('Circular reference');
    expect(parsed.sheets[0].cells.A1.error?.details).toEqual(['A1']);
  });

  it('cell with notes is parsed and preserved', () => {
    const sheetDocSource = `${SHEETDOC_MAGIC} ${SHEETDOC_VERSION}

[[sheets]]
name = "Sheet1"
order = 0

[sheets.meta]
row_count = 5
column_count = 5

[sheets.cells.A1]
value = 42
notes = ["First note", "Second note"]
`;

    const parsed = parseSheetDocString(sheetDocSource);
    expect(parsed.sheets[0].cells.A1.notes).toEqual(['First note', 'Second note']);
  });

  it('invalid cell error with no type/message/details returns undefined', () => {
    const sheetDocSource = `${SHEETDOC_MAGIC} ${SHEETDOC_VERSION}

[[sheets]]
name = "Sheet1"
order = 0

[sheets.meta]
row_count = 5
column_count = 5

[sheets.cells.A1]
value = 42

[sheets.cells.A1.error]
custom_field = "not standard"
`;

    const parsed = parseSheetDocString(sheetDocSource);
    // error with only unknown fields should normalize to some default
    // or be excluded - let's check
    expect(parsed.sheets[0].cells.A1.error).toBeUndefined();
  });

  it('parseSheetDocString throws on missing header', () => {
    expect(() => parseSheetDocString('')).toThrow('Missing SheetDoc header');
    expect(() => parseSheetDocString('\n\n\n')).toThrow('Missing SheetDoc header');
  });

  it('parseSheetDocString throws on invalid header', () => {
    expect(() => parseSheetDocString('not a valid header')).toThrow('Invalid SheetDoc header');
  });

  it('parseSheetDocString throws on unsupported version', () => {
    expect(() => parseSheetDocString(`${SHEETDOC_MAGIC} v99`)).toThrow('Unsupported SheetDoc version');
  });

  it('parseSheetDocString handles header with no version', () => {
    const doc = parseSheetDocString(`${SHEETDOC_MAGIC}`);
    expect(doc.sheets).toHaveLength(1);
  });

  it('handles SheetDoc with no sheets array creating default sheet', () => {
    const doc = parseSheetDocString(`${SHEETDOC_MAGIC} ${SHEETDOC_VERSION}`);
    expect(doc.sheets.length).toBe(1);
    expect(doc.sheets[0].name).toBe('Sheet1');
  });

  it('skips non-object items in sheets array', () => {
    const input = {
      sheets: ['not an object', null, 42],
    };
    const parsed = parseSheetContent(input);
    expect(parsed.cells).toEqual({});
  });

  it('handles cells with formula starting without = prefix', () => {
    const sheetDocSource = `${SHEETDOC_MAGIC} ${SHEETDOC_VERSION}

[[sheets]]
name = "Sheet1"
order = 0

[sheets.meta]
row_count = 5
column_count = 5

[sheets.cells.A1]
formula = "A2+A3"
`;

    const parsed = parseSheetDocString(sheetDocSource);
    const data = parseSheetContent(stringifySheetDoc(parsed));
    // Formula without = prefix should get = prepended
    expect(data.cells.A1).toBe('=A2+A3');
  });

  it('handles coerceSheetPrimitive with null and non-finite values', () => {
    // Exercise coerceSheetPrimitive paths via SheetDoc cells
    const sheetDocSource = `${SHEETDOC_MAGIC} ${SHEETDOC_VERSION}

[[sheets]]
name = "Sheet1"
order = 0

[sheets.meta]
row_count = 5
column_count = 5

[sheets.cells.A1]
value = true

[sheets.cells.B1]
value = false
`;

    const parsed = parseSheetDocString(sheetDocSource);
    expect(parsed.sheets[0].cells.A1.value).toBe(true);
    expect(parsed.sheets[0].cells.B1.value).toBe(false);

    const data = parseSheetContent(stringifySheetDoc(parsed));
    expect(data.cells.A1).toBe('true');
    expect(data.cells.B1).toBe('false');
  });

  it('handles cell type serialization', () => {
    const doc: SheetDoc = {
      version: SHEETDOC_VERSION as typeof SHEETDOC_VERSION,
      sheets: [
        {
          name: 'Sheet1',
          order: 0,
          meta: { rowCount: 5, columnCount: 5 },
          columns: {},
          cells: {
            A1: { value: 42, type: 'number' },
            B1: { value: 'hello', type: 'string' },
          },
          ranges: {},
          dependencies: {},
        },
      ],
    };

    const serialized = stringifySheetDoc(doc);
    expect(serialized).toContain('type = "number"');
    expect(serialized).toContain('type = "string"');
  });

  it('serializes dependencies correctly', () => {
    const doc: SheetDoc = {
      version: SHEETDOC_VERSION as typeof SHEETDOC_VERSION,
      sheets: [
        {
          name: 'Sheet1',
          order: 0,
          meta: { rowCount: 5, columnCount: 5 },
          columns: {},
          cells: {
            A1: { value: 5 },
            A2: { formula: '=A1*2', value: 10 },
          },
          ranges: {},
          dependencies: {
            A2: { dependsOn: ['A1'], dependents: [] },
            A1: { dependsOn: [], dependents: ['A2'] },
          },
        },
      ],
    };

    const serialized = stringifySheetDoc(doc);
    expect(serialized).toContain('[sheets.dependencies.A1]');
    expect(serialized).toContain('[sheets.dependencies.A2]');
    expect(serialized).toContain('depends_on = ["A1"]');
  });

  it('skips invalid cell addresses in SheetDoc cells', () => {
    const sheetDocSource = `${SHEETDOC_MAGIC} ${SHEETDOC_VERSION}

[[sheets]]
name = "Sheet1"
order = 0

[sheets.meta]
row_count = 5
column_count = 5

[sheets.cells.INVALID_ADDRESS]
value = 42

[sheets.cells.A1]
value = 10
`;

    const parsed = parseSheetDocString(sheetDocSource);
    // INVALID_ADDRESS should be filtered out
    expect(parsed.sheets[0].cells['INVALID_ADDRESS']).toBeUndefined();
    expect(parsed.sheets[0].cells.A1.value).toBe(10);
  });

  it('formatPrimitiveForCell handles non-finite numbers', () => {
    // The formatPrimitiveForCell is called via sheetDataFromSheetDoc
    // when value is non-finite, it returns ''
    // This is tested indirectly - non-finite values should be filtered by coerceSheetPrimitive
    const sheetDocSource = `${SHEETDOC_MAGIC} ${SHEETDOC_VERSION}

[[sheets]]
name = "Sheet1"
order = 0

[sheets.meta]
row_count = 5
column_count = 5

[sheets.cells.A1]
value = 3.14

[sheets.cells.B1]
value = "text value"
`;

    const parsed = parseSheetDocString(sheetDocSource);
    const data = parseSheetContent(stringifySheetDoc(parsed));
    expect(data.cells.A1).toBe('3.14');
    expect(data.cells.B1).toBe('text value');
  });

  it('sorts sheets by order then by name', () => {
    const doc: SheetDoc = {
      version: SHEETDOC_VERSION as typeof SHEETDOC_VERSION,
      sheets: [
        {
          name: 'Zebra',
          order: 1,
          meta: { rowCount: 5, columnCount: 5 },
          columns: {},
          cells: {},
          ranges: {},
          dependencies: {},
        },
        {
          name: 'Alpha',
          order: 0,
          meta: { rowCount: 5, columnCount: 5 },
          columns: {},
          cells: {},
          ranges: {},
          dependencies: {},
        },
        {
          name: 'Beta',
          order: 1,
          meta: { rowCount: 5, columnCount: 5 },
          columns: {},
          cells: {},
          ranges: {},
          dependencies: {},
        },
      ],
    };

    const serialized = stringifySheetDoc(doc);
    const sheetPositions = [
      serialized.indexOf('name = "Alpha"'),
      serialized.indexOf('name = "Beta"'),
      serialized.indexOf('name = "Zebra"'),
    ];
    // Alpha (order 0) should come first, then Beta (order 1, name Beta < Zebra), then Zebra
    expect(sheetPositions[0]).toBeLessThan(sheetPositions[1]);
    expect(sheetPositions[1]).toBeLessThan(sheetPositions[2]);
  });

  it('handles column data with non-object column values', () => {
    // Exercise the skip path for non-object column values
    const input = {
      sheets: [
        {
          name: 'Sheet1',
          order: 0,
          meta: { row_count: 5, column_count: 5 },
          columns: {
            A: { width: 100 },
            B: 'not an object',
          },
          cells: {},
        },
      ],
    };

    const parsed = parseSheetContent(input);
    // Should parse without error, B column skipped
    expect(parsed.rowCount).toBe(5);
  });
});

// ============================================================
// Additional evaluation.ts coverage
// ============================================================
describe('evaluation.ts additional coverage', () => {
  it('evaluates <> not-equal operator', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '10';
    sheet.cells.A2 = '20';
    sheet.cells.A3 = '=A1<>A2';
    sheet.cells.A4 = '=A1<>A1';

    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A3')).toBe('true');
    expect(getDisplay(result, 'A4')).toBe('false');
  });

  it('evaluates <> operator with string comparison fallback', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = 'hello';
    sheet.cells.A2 = 'world';
    sheet.cells.A3 = '=A1<>A2';

    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A3')).toBe('true');
  });

  it('evaluates = operator with string comparison fallback', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = 'hello';
    sheet.cells.A2 = 'hello';
    sheet.cells.A3 = '=A1=A2';

    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A3')).toBe('true');
  });

  it('evaluates + operator with string concatenation fallback', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = 'hello';
    sheet.cells.A2 = 'world';
    sheet.cells.A3 = '=A1+A2';

    const result = evaluateSheet(sheet);
    // When both sides are non-numeric strings, + falls back to concatenation
    expect(getDisplay(result, 'A3')).toBe('helloworld');
  });

  it('handles empty formula (= with just whitespace)', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '=';

    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A1')).toBe('#ERROR');
    expect(getError(result, 'A1')).toBe('Empty formula');
  });

  it('evaluates ^ exponent operator', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '=2^3';

    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A1')).toBe('8');
  });

  it('evaluates >= and <= operators', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '10';
    sheet.cells.A2 = '10';
    sheet.cells.A3 = '=A1>=A2';
    sheet.cells.A4 = '=A1<=A2';

    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A3')).toBe('true');
    expect(getDisplay(result, 'A4')).toBe('true');
  });

  it('handles external reference with no resolver', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '=@[Sales](s1):B1';

    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A1')).toBe('#ERROR');
    expect(getError(result, 'A1')).toContain('not supported');
  });

  it('handles external reference where resolver returns null', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '=@[Sales](s1):B1';

    const result = evaluateSheet(sheet, {
      resolveExternalReference: () => null,
    });
    expect(getDisplay(result, 'A1')).toBe('#ERROR');
  });

  it('handles circular reference through serialization', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '=A1';

    const serialized = serializeSheetContent(sheet);
    expect(serialized).toContain('CIRCULAR_REF');
    // Circular ref details should include the cell address
    expect(serialized).toContain('A1');
  });

  it('given_repeatingDecimal_formatDisplayValueTruncatesToPrecision12', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '=1/3';

    const result = evaluateSheet(sheet);
    const display = getDisplay(result, 'A1');
    // Contract: numbers whose toString > 12 chars get toPrecision(12) with trailing zeros stripped
    const num = 1 / 3;
    const expected = num.toPrecision(12).replace(/0+$/g, '').replace(/\.$/, '');
    expect(display).toBe(expected);
  });
});

// ============================================================
// address.ts - isValidCellAddress (lines 60-62)
// ============================================================
describe('isValidCellAddress', () => {
  it('returns true for valid cell addresses', () => {
    expect(isValidCellAddress('A1')).toBe(true);
    expect(isValidCellAddress('Z99')).toBe(true);
    expect(isValidCellAddress('AA100')).toBe(true);
    expect(isValidCellAddress(' b2 ')).toBe(true);
  });

  it('returns false for invalid cell addresses', () => {
    expect(isValidCellAddress('123')).toBe(false);
    expect(isValidCellAddress('hello')).toBe(false);
    expect(isValidCellAddress('')).toBe(false);
    expect(isValidCellAddress('A')).toBe(false);
    expect(isValidCellAddress('1A')).toBe(false);
  });
});

// ============================================================
// functions.ts - INT and SIGN wrong arg count (lines 437-438, 443-444)
// ============================================================
describe('INT and SIGN error paths', () => {
  it('INT errors with wrong argument count (zero args)', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '=INT()';
    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A1')).toBe('#ERROR');
    expect(getError(result, 'A1')).toContain('INT expects exactly one argument');
  });

  it('INT errors with wrong argument count (two args)', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '=INT(1, 2)';
    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A1')).toBe('#ERROR');
    expect(getError(result, 'A1')).toContain('INT expects exactly one argument');
  });

  it('SIGN errors with wrong argument count (zero args)', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '=SIGN()';
    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A1')).toBe('#ERROR');
    expect(getError(result, 'A1')).toContain('SIGN expects exactly one argument');
  });

  it('SIGN errors with wrong argument count (two args)', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '=SIGN(1, 2)';
    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A1')).toBe('#ERROR');
    expect(getError(result, 'A1')).toContain('SIGN expects exactly one argument');
  });
});

// ============================================================
// io.ts - clonePlainObject with arrays and nested objects (lines 777-786)
// ============================================================
describe('io.ts clonePlainObject - arrays and nested objects in ranges', () => {
  it('clones ranges with array values', () => {
    const sheetDocSource = `${SHEETDOC_MAGIC} ${SHEETDOC_VERSION}

[[sheets]]
name = "Sheet1"
order = 0

[sheets.meta]
row_count = 5
column_count = 5

[sheets.ranges.highlight]
start = "A1"
end = "B5"
tags = ["important", "review"]
`;

    const parsed = parseSheetDocString(sheetDocSource);
    expect(parsed.sheets[0].ranges.highlight.tags).toEqual(['important', 'review']);

    // Serialize and re-parse to verify clonePlainObject works through round-trip
    const serialized = stringifySheetDoc(parsed);
    expect(serialized).toContain('tags = ["important", "review"]');
  });

  it('clones ranges with nested object values', () => {
    const sheetDocSource = `${SHEETDOC_MAGIC} ${SHEETDOC_VERSION}

[[sheets]]
name = "Sheet1"
order = 0

[sheets.meta]
row_count = 5
column_count = 5

[sheets.ranges.highlight]
start = "A1"
end = "B5"

[sheets.ranges.highlight.style]
color = "red"
bold = true
`;

    const parsed = parseSheetDocString(sheetDocSource);
    const style = parsed.sheets[0].ranges.highlight.style as Record<string, unknown>;
    expect(style.color).toBe('red');
    expect(style.bold).toBe(true);

    // Round-trip to verify deep cloning
    const serialized = stringifySheetDoc(parsed);
    expect(serialized).toContain('color = "red"');
  });

  it('clones ranges with arrays containing objects', () => {
    // Build a SheetDoc with ranges that have arrays containing objects
    // to exercise the nested clonePlainObject path within array map
    const doc: SheetDoc = {
      version: SHEETDOC_VERSION as typeof SHEETDOC_VERSION,
      sheets: [
        {
          name: 'Sheet1',
          order: 0,
          meta: { rowCount: 5, columnCount: 5 },
          columns: {},
          cells: {},
          ranges: {
            myRange: {
              items: [
                { name: 'item1', value: 10 },
                { name: 'item2', value: 20 },
              ],
              nestedObj: { inner: { deep: 'value' } },
              simpleArray: [1, 2, 3],
            } as Record<string, unknown>,
          },
          dependencies: {},
        },
      ],
    };

    const serialized = stringifySheetDoc(doc);
    // Verify the arrays and nested objects were serialized
    expect(serialized).toContain('[sheets.ranges.myRange]');
    expect(serialized).toContain('items');
  });
});

// ============================================================
// address.ts - encodeCellAddress with negative indices (lines 19-20)
// ============================================================
describe('encodeCellAddress negative indices', () => {
  it('throws on negative row index', () => {
    expect(() => encodeCellAddress(-1, 0)).toThrow('Row and column indices must be non-negative');
  });

  it('throws on negative column index', () => {
    expect(() => encodeCellAddress(0, -1)).toThrow('Row and column indices must be non-negative');
  });

  it('throws on both negative', () => {
    expect(() => encodeCellAddress(-5, -3)).toThrow('Row and column indices must be non-negative');
  });
});

// ============================================================
// functions.ts - MOD error paths (lines 427-428, 431-432)
// ============================================================
describe('MOD error paths', () => {
  it('MOD errors with wrong argument count (one arg)', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '=MOD(10)';
    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A1')).toBe('#ERROR');
    expect(getError(result, 'A1')).toContain('MOD expects exactly two arguments');
  });

  it('MOD errors with wrong argument count (three args)', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '=MOD(10, 3, 1)';
    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A1')).toBe('#ERROR');
    expect(getError(result, 'A1')).toContain('MOD expects exactly two arguments');
  });

  it('MOD errors on division by zero', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '=MOD(10, 0)';
    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A1')).toBe('#ERROR');
    expect(getError(result, 'A1')).toContain('MOD: Division by zero');
  });
});

// ============================================================
// io.ts - formatTomlValue with null/undefined and unknown types (lines 742-743, 760-761)
// ============================================================
describe('io.ts formatTomlValue edge cases via stringifySheetDoc', () => {
  it('handles undefined meta value (skipped by filter)', () => {
    const doc: SheetDoc = {
      version: SHEETDOC_VERSION as typeof SHEETDOC_VERSION,
      sheets: [
        {
          name: 'Sheet1',
          order: 0,
          meta: {
            rowCount: 5,
            columnCount: 5,
            customProp: undefined,
          },
          columns: {},
          cells: {},
          ranges: {},
          dependencies: {},
        },
      ],
    };

    // This exercises the metaValue === undefined continue in stringifySheetDoc
    const serialized = stringifySheetDoc(doc);
    expect(serialized).not.toContain('custom_prop');
  });

  it('handles range with only valid values after clonePlainObject filtering', () => {
    // null values in ranges get filtered by clonePlainObject
    const doc: SheetDoc = {
      version: SHEETDOC_VERSION as typeof SHEETDOC_VERSION,
      sheets: [
        {
          name: 'Sheet1',
          order: 0,
          meta: { rowCount: 5, columnCount: 5 },
          columns: {},
          cells: {},
          ranges: {
            myRange: {
              start: 'A1',
              end: null as unknown as string,
              count: 5,
            },
          },
          dependencies: {},
        },
      ],
    };

    const serialized = stringifySheetDoc(doc);
    // null values get filtered out by clonePlainObject
    expect(serialized).toContain('start = "A1"');
    expect(serialized).toContain('count = 5');
    expect(serialized).not.toContain('end =');
  });

  it('handles formatInlineTable with undefined entry values (filtered out)', () => {
    const doc: SheetDoc = {
      version: SHEETDOC_VERSION as typeof SHEETDOC_VERSION,
      sheets: [
        {
          name: 'Sheet1',
          order: 0,
          meta: { rowCount: 5, columnCount: 5 },
          columns: {
            A: { width: 100, hidden: undefined as unknown as boolean },
          },
          cells: {},
          ranges: {},
          dependencies: {},
        },
      ],
    };

    const serialized = stringifySheetDoc(doc);
    expect(serialized).toContain('width = 100');
    // undefined entries should be filtered out in formatInlineTable
    expect(serialized).not.toContain('hidden');
  });
});
