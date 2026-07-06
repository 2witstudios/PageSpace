import type { FormFieldDef } from '@pagespace/db/schema/form-targets';
import type { SheetCellUpdate } from '../sheets/types';
import { encodeCellAddress } from '../sheets/address';

/**
 * Header-row cell updates — one per field, in column order. `headerRow` is
 * 1-indexed to match `form_targets.headerRow`.
 */
export function buildHeaderRowUpdates(fields: FormFieldDef[], headerRow: number): SheetCellUpdate[] {
  const rowIndex = headerRow - 1;
  return fields.map((field, columnIndex) => ({
    address: encodeCellAddress(rowIndex, columnIndex),
    value: field.label,
  }));
}

/**
 * Data-row cell updates for one submission. `fields[i]` always maps to column
 * `i` — the same fixed mapping used for the header row, never re-derived from
 * live sheet content. A field with no submitted value is omitted rather than
 * writing an empty cell.
 */
export function buildSubmissionRowUpdates(
  fields: FormFieldDef[],
  targetRow: number,
  values: Record<string, string | boolean>
): SheetCellUpdate[] {
  const rowIndex = targetRow - 1;
  const updates: SheetCellUpdate[] = [];

  fields.forEach((field, columnIndex) => {
    const value = values[field.name];
    if (value === undefined) return;
    updates.push({
      address: encodeCellAddress(rowIndex, columnIndex),
      value: typeof value === 'boolean' ? (value ? 'true' : 'false') : value,
    });
  });

  return updates;
}
