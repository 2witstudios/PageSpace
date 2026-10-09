/**
 * Shared sheet constants.
 *
 * The mention trigger pattern for the formula bar / cell editor: allow an `@`
 * mention at the start of the input or immediately after a formula operator,
 * separator, comparison, or whitespace — never mid-word. Single source of truth
 * for both SheetView's formula bar and the FloatingCellEditor.
 */
export const sheetTriggerPattern = /^$|^[\s(=+\-*/,<>!]$/;
