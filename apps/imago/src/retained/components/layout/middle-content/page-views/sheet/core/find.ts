import { encodeCellAddress, type SheetData } from '@pagespace/lib/sheets/sheet';
import type { DisplayLookup } from './clipboard';

/**
 * Pure find core: the addresses of cells whose raw content or evaluated display
 * value contains the query (case-insensitive). A cell matches even when only
 * its display value (not the raw formula) contains the query.
 */
export const buildFindMatches = (
  query: string,
  sheet: SheetData,
  displayAt: DisplayLookup,
): string[] => {
  if (!query) {
    return [];
  }

  const q = query.toLowerCase();
  const matches: string[] = [];
  for (let row = 0; row < sheet.rowCount; row++) {
    for (let col = 0; col < sheet.columnCount; col++) {
      const address = encodeCellAddress(row, col);
      const raw = sheet.cells[address] ?? '';
      const shown = displayAt(row, col);
      if (raw.toLowerCase().includes(q) || shown.toLowerCase().includes(q)) {
        matches.push(address);
      }
    }
  }
  return matches;
};
