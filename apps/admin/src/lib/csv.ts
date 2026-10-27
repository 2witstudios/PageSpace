/**
 * Shared CSV serialization for admin exports. Every cell goes through the
 * spreadsheet formula-injection guard — a field starting with = + - or @
 * must never open as a live formula in Excel/Sheets.
 */

export function sanitizeSpreadsheetCell(value: string): string {
  if (/^-?\d+(\.\d+)?$/.test(value)) return value;
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

export function csvField(value: string | number | null): string {
  const s = sanitizeSpreadsheetCell(value === null ? '' : String(value));
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: (string | number | null)[][]): string {
  return rows.map((row) => row.map(csvField).join(',')).join('\r\n');
}
