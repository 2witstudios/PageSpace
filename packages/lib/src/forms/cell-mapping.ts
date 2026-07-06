import type { FormFieldDef } from '@pagespace/db/schema/form-targets';
import type { SheetCellUpdate } from '../sheets/types';
import { encodeCellAddress } from '../sheets/address';

/**
 * Header-row cell updates — one per field, in column order. `headerRow` is
 * 1-indexed to match `form_targets.headerRow`. Archived fields are skipped —
 * their column keeps whatever header text was already written (mirrors
 * Google Forms leaving a deleted question's column header alone) — but the
 * array index (and therefore every later field's column) is never shifted by
 * the skip, since `columnIndex` comes from the full-array `forEach`, not from
 * a filtered array's position.
 */
export function buildHeaderRowUpdates(fields: FormFieldDef[], headerRow: number): SheetCellUpdate[] {
  const rowIndex = headerRow - 1;
  const updates: SheetCellUpdate[] = [];

  fields.forEach((field, columnIndex) => {
    if (field.archived) return;
    updates.push({
      address: encodeCellAddress(rowIndex, columnIndex),
      value: field.label,
    });
  });

  return updates;
}

/**
 * Data-row cell updates for one submission. `fields[i]` always maps to column
 * `i` — the same fixed mapping used for the header row, never re-derived from
 * live sheet content. A field with no submitted value is omitted rather than
 * writing an empty cell. Archived fields are always skipped — they stop
 * receiving new data even if a stale embedded form still submits their name.
 */
export function buildSubmissionRowUpdates(
  fields: FormFieldDef[],
  targetRow: number,
  values: Record<string, string | boolean>
): SheetCellUpdate[] {
  const rowIndex = targetRow - 1;
  const updates: SheetCellUpdate[] = [];

  fields.forEach((field, columnIndex) => {
    if (field.archived) return;
    const value = values[field.name];
    if (value === undefined) return;
    updates.push({
      address: encodeCellAddress(rowIndex, columnIndex),
      value: typeof value === 'boolean' ? (value ? 'true' : 'false') : value,
    });
  });

  return updates;
}
