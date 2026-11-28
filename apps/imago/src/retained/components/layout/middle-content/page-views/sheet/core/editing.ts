/**
 * Pure predicate for the sheet's editing-store registration. SheetView is the
 * only editor view that was never registered with `useEditingStore`, so its
 * edits were unprotected from auth-refresh interruption and SWR clobbering.
 * An editing session should be active whenever a cell is being edited, the
 * formula bar is focused, or the document has unsaved changes.
 */
export interface SheetEditingSignals {
  isEditingCell: boolean;
  isFormulaFocused: boolean;
  isDirty: boolean;
}

export const shouldRegisterSheetEditing = ({
  isEditingCell,
  isFormulaFocused,
  isDirty,
}: SheetEditingSignals): boolean => isEditingCell || isFormulaFocused || isDirty;
