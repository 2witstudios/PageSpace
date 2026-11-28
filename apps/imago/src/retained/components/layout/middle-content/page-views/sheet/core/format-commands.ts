/**
 * Pure formatting commands for the toolbar.
 *
 * A toolbar button is a *command* over the current selection, not a mutation of
 * a cell: "bold" means "make the whole selection match the opposite of what the
 * anchor cell is". Keeping that decision here — rather than inside a click
 * handler — is what makes it testable and what keeps every mutation funnelled
 * through the lib's `format-ops`, which is the single surface PR 5's structural
 * edits have to keep in step.
 */

import {
  MAX_DECIMALS,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  addressesInRange,
  clearCellFormats,
  getEffectiveCellFormat,
  setCellFormats,
  type CellFontFamily,
  type CellFormat,
  type CellHorizontalAlign,
  type CellVerticalAlign,
  type NumberFormat,
  type NumberFormatKind,
  type SheetData,
} from '@pagespace/lib/sheets/sheet';
import { getPrimaryCell, type SelectionState } from './selection';

/** The boolean run-style fields a toolbar toggles. */
export type ToggleField = 'bold' | 'italic' | 'underline' | 'strike' | 'wrap';

export type FormatCommand =
  | { kind: 'toggle'; field: ToggleField }
  | { kind: 'align'; value: CellHorizontalAlign | undefined }
  | { kind: 'valign'; value: CellVerticalAlign | undefined }
  | { kind: 'color'; value: string | undefined }
  | { kind: 'background'; value: string | undefined }
  | { kind: 'fontSize'; value: number | undefined }
  | { kind: 'fontFamily'; value: CellFontFamily | undefined }
  | { kind: 'numberKind'; value: NumberFormatKind }
  | { kind: 'decimals'; delta: number }
  | { kind: 'clear' };

/** Every address the selection covers, row-major. */
export const selectionAddresses = (selection: SelectionState): string[] =>
  selection.type === 'single'
    ? addressesInRange(selection.cell, selection.cell)
    : addressesInRange(selection.range.start, selection.range.end);

/**
 * The format the toolbar should reflect: the anchor cell's, with its column
 * default already folded in. Google Sheets shows the anchor rather than the
 * intersection of the range, and matching that avoids a toolbar that goes blank
 * whenever a selection is not perfectly uniform.
 */
export const activeFormat = (sheet: SheetData, selection: SelectionState): CellFormat => {
  const cell = getPrimaryCell(selection);
  const [address] = addressesInRange(cell, cell);
  return getEffectiveCellFormat(sheet, address) ?? {};
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * How many decimals a raw value already shows, so the first press of
 * "increase decimals" moves one step from what the user sees rather than
 * snapping to an arbitrary default.
 */
export const inferDecimals = (raw: string | undefined): number => {
  if (!raw) return 0;
  const match = /^-?\d*\.(\d+)$/.exec(raw.trim());
  return match ? clamp(match[1].length, 0, MAX_DECIMALS) : 0;
};

/**
 * Switching number kind keeps the settings that still apply. Going to currency
 * from a 2-decimal number should stay at 2 decimals; going to `text` should not
 * carry a currency code that now means nothing.
 */
const nextNumberFormat = (
  current: NumberFormat | undefined,
  kind: NumberFormatKind,
): NumberFormat | undefined => {
  if (kind === 'auto') return undefined;

  const base: NumberFormat = { kind };

  if (kind === 'number' || kind === 'currency' || kind === 'percent' || kind === 'scientific') {
    if (current?.decimals !== undefined) base.decimals = current.decimals;
    if (current?.thousands !== undefined) base.thousands = current.thousands;
  }
  if (kind === 'currency') {
    base.currency = current?.currency ?? 'USD';
  }
  if (kind === 'date' || kind === 'time' || kind === 'datetime') {
    if (current?.dateStyle !== undefined) base.dateStyle = current.dateStyle;
  }

  return base;
};

/**
 * Apply a command to the selection.
 *
 * Returns the sheet unchanged when the command is a no-op, so a caller can
 * treat identity as "nothing to persist" and avoid pushing an empty entry onto
 * the undo stack.
 */
export const applyFormatCommand = (
  sheet: SheetData,
  selection: SelectionState,
  command: FormatCommand,
): SheetData => {
  const addresses = selectionAddresses(selection);
  if (addresses.length === 0) return sheet;

  const current = activeFormat(sheet, selection);

  switch (command.kind) {
    case 'clear':
      return clearCellFormats(sheet, addresses);

    case 'toggle': {
      // Anchor-relative: if the anchor is on, the command turns the whole
      // selection off. `undefined` clears the field rather than storing `false`,
      // keeping an unstyled cell genuinely unstyled.
      const turningOn = !current[command.field];
      return setCellFormats(sheet, addresses, {
        [command.field]: turningOn ? true : undefined,
      });
    }

    case 'align':
      return setCellFormats(sheet, addresses, { align: command.value });

    case 'valign':
      return setCellFormats(sheet, addresses, { valign: command.value });

    case 'color':
      return setCellFormats(sheet, addresses, { color: command.value });

    case 'background':
      return setCellFormats(sheet, addresses, { background: command.value });

    case 'fontFamily':
      return setCellFormats(sheet, addresses, { fontFamily: command.value });

    case 'fontSize':
      return setCellFormats(sheet, addresses, {
        fontSize:
          command.value === undefined
            ? undefined
            : clamp(Math.round(command.value), MIN_FONT_SIZE, MAX_FONT_SIZE),
      });

    case 'numberKind': {
      const next = nextNumberFormat(current.number, command.value);
      return setCellFormats(sheet, addresses, { number: next });
    }

    case 'decimals': {
      const anchor = getPrimaryCell(selection);
      const [anchorAddress] = addressesInRange(anchor, anchor);
      const startingDecimals =
        current.number?.decimals ?? inferDecimals(sheet.cells[anchorAddress]);
      const decimals = clamp(startingDecimals + command.delta, 0, MAX_DECIMALS);

      if (decimals === current.number?.decimals) return sheet;

      // Nudging decimals on an unformatted cell is an implicit request for a
      // number format; otherwise the setting would be stored and never shown.
      const kind = current.number?.kind ?? 'number';
      return setCellFormats(sheet, addresses, {
        number: { ...(current.number ?? { kind }), kind, decimals },
      });
    }
  }
};
