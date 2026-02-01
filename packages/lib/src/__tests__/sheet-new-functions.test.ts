import { describe, it, expect } from 'vitest';
import { createEmptySheet, evaluateSheet, SheetData } from '../sheets/sheet';

const getDisplay = (evaluation: ReturnType<typeof evaluateSheet>, address: string) => {
  return evaluation.byAddress[address]?.display;
};

const getError = (evaluation: ReturnType<typeof evaluateSheet>, address: string) => {
  return evaluation.byAddress[address]?.error;
};

describe('new string functions', () => {
  it('UPPER converts text to uppercase', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = 'hello world';
    sheet.cells.A2 = '=UPPER(A1)';
    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A2')).toBe('HELLO WORLD');
  });

  it('LOWER converts text to lowercase', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = 'HELLO WORLD';
    sheet.cells.A2 = '=LOWER(A1)';
    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A2')).toBe('hello world');
  });

  it('TRIM removes leading and trailing whitespace', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '  hello world  ';
    sheet.cells.A2 = '=TRIM(A1)';
    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A2')).toBe('hello world');
  });

  it('LEN returns string length', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = 'hello';
    sheet.cells.A2 = '=LEN(A1)';
    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A2')).toBe('5');
  });

  it('LEFT extracts characters from the start', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = 'hello world';
    sheet.cells.A2 = '=LEFT(A1, 5)';
    sheet.cells.A3 = '=LEFT(A1)';
    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A2')).toBe('hello');
    expect(getDisplay(result, 'A3')).toBe('h');
  });

  it('RIGHT extracts characters from the end', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = 'hello world';
    sheet.cells.A2 = '=RIGHT(A1, 5)';
    sheet.cells.A3 = '=RIGHT(A1)';
    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A2')).toBe('world');
    expect(getDisplay(result, 'A3')).toBe('d');
  });

  it('MID extracts characters from the middle', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = 'hello world';
    sheet.cells.A2 = '=MID(A1, 7, 5)';
    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A2')).toBe('world');
  });

  it('SUBSTITUTE replaces text', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = 'hello world';
    sheet.cells.A2 = '=SUBSTITUTE(A1, "world", "there")';
    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A2')).toBe('hello there');
  });

  it('REPT repeats text', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = 'ab';
    sheet.cells.A2 = '=REPT(A1, 3)';
    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A2')).toBe('ababab');
  });

  it('FIND locates text (case-sensitive)', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = 'hello world';
    sheet.cells.A2 = '=FIND("world", A1)';
    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A2')).toBe('7');
  });

  it('SEARCH locates text (case-insensitive)', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = 'Hello World';
    sheet.cells.A2 = '=SEARCH("WORLD", A1)';
    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A2')).toBe('7');
  });
});

describe('new date functions', () => {
  it('TODAY returns current date', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '=TODAY()';
    const result = evaluateSheet(sheet);
    const display = getDisplay(result, 'A1');
    expect(display).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('NOW returns current timestamp', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '=NOW()';
    const result = evaluateSheet(sheet);
    const display = getDisplay(result, 'A1');
    expect(display).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('YEAR extracts year from date', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '2024-06-15';
    sheet.cells.A2 = '=YEAR(A1)';
    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A2')).toBe('2024');
  });

  it('MONTH extracts month from date', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '2024-06-15';
    sheet.cells.A2 = '=MONTH(A1)';
    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A2')).toBe('6');
  });

  it('DAY extracts day from date', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '2024-06-15';
    sheet.cells.A2 = '=DAY(A1)';
    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A2')).toBe('15');
  });
});

describe('new logical functions', () => {
  it('AND returns true only if all arguments are true', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '=AND(true, true)';
    sheet.cells.A2 = '=AND(true, false)';
    sheet.cells.A3 = '=AND(1, 2, 3)';
    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A1')).toBe('true');
    expect(getDisplay(result, 'A2')).toBe('false');
    expect(getDisplay(result, 'A3')).toBe('true');
  });

  it('OR returns true if any argument is true', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '=OR(true, false)';
    sheet.cells.A2 = '=OR(false, false)';
    sheet.cells.A3 = '=OR(0, 1)';
    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A1')).toBe('true');
    expect(getDisplay(result, 'A2')).toBe('false');
    expect(getDisplay(result, 'A3')).toBe('true');
  });

  it('NOT negates a boolean', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '=NOT(true)';
    sheet.cells.A2 = '=NOT(false)';
    sheet.cells.A3 = '=NOT(0)';
    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A1')).toBe('false');
    expect(getDisplay(result, 'A2')).toBe('true');
    expect(getDisplay(result, 'A3')).toBe('true');
  });

  it('IFERROR catches errors and returns alternative', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '0';
    sheet.cells.A2 = '=IFERROR(1/A1, "Error")';
    sheet.cells.A3 = '=IFERROR(1+1, "Error")';
    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A2')).toBe('Error');
    expect(getDisplay(result, 'A3')).toBe('2');
  });

  it('ISBLANK checks for empty cells', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '';
    sheet.cells.A2 = 'text';
    sheet.cells.B1 = '=ISBLANK(A1)';
    sheet.cells.B2 = '=ISBLANK(A2)';
    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'B1')).toBe('true');
    expect(getDisplay(result, 'B2')).toBe('false');
  });

  it('ISNUMBER checks for numeric values', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '42';
    sheet.cells.A2 = 'text';
    sheet.cells.B1 = '=ISNUMBER(A1)';
    sheet.cells.B2 = '=ISNUMBER(A2)';
    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'B1')).toBe('true');
    expect(getDisplay(result, 'B2')).toBe('false');
  });

  it('ISTEXT checks for text values', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = 'hello';
    sheet.cells.A2 = '42';
    sheet.cells.B1 = '=ISTEXT(A1)';
    sheet.cells.B2 = '=ISTEXT(A2)';
    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'B1')).toBe('true');
    expect(getDisplay(result, 'B2')).toBe('false');
  });
});

describe('new math functions', () => {
  it('SQRT calculates square root', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '=SQRT(16)';
    sheet.cells.A2 = '=SQRT(2)';
    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A1')).toBe('4');
    expect(parseFloat(getDisplay(result, 'A2')!)).toBeCloseTo(1.414, 2);
  });

  it('SQRT errors on negative numbers', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '=SQRT(-1)';
    const result = evaluateSheet(sheet);
    expect(getError(result, 'A1')).toBeDefined();
  });

  it('POWER calculates exponentiation', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '=POWER(2, 3)';
    sheet.cells.A2 = '=POW(3, 2)';
    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A1')).toBe('8');
    expect(getDisplay(result, 'A2')).toBe('9');
  });

  it('MOD calculates modulo', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '=MOD(10, 3)';
    sheet.cells.A2 = '=MOD(7, 2)';
    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A1')).toBe('1');
    expect(getDisplay(result, 'A2')).toBe('1');
  });

  it('INT truncates to integer', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '=INT(5.9)';
    sheet.cells.A2 = '=INT(-5.9)';
    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A1')).toBe('5');
    expect(getDisplay(result, 'A2')).toBe('-6');
  });

  it('SIGN returns sign of number', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '=SIGN(5)';
    sheet.cells.A2 = '=SIGN(-5)';
    sheet.cells.A3 = '=SIGN(0)';
    const result = evaluateSheet(sheet);
    expect(getDisplay(result, 'A1')).toBe('1');
    expect(getDisplay(result, 'A2')).toBe('-1');
    expect(getDisplay(result, 'A3')).toBe('0');
  });

  it('PI returns pi constant', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '=PI()';
    const result = evaluateSheet(sheet);
    expect(parseFloat(getDisplay(result, 'A1')!)).toBeCloseTo(3.14159, 4);
  });

  it('RAND returns random number between 0 and 1', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '=RAND()';
    const result = evaluateSheet(sheet);
    const value = parseFloat(getDisplay(result, 'A1')!);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(1);
  });

  it('RANDBETWEEN returns random integer in range', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '=RANDBETWEEN(1, 10)';
    const result = evaluateSheet(sheet);
    const value = parseInt(getDisplay(result, 'A1')!, 10);
    expect(value).toBeGreaterThanOrEqual(1);
    expect(value).toBeLessThanOrEqual(10);
  });
});
