/**
 * Conflict detection for rollback previews.
 *
 * Pure, effect-free functions comparing a recorded activity's values against
 * the resource's current state. The DB lookup that discovers whether a later
 * modification came from outside the undo group is an effect and stays in the
 * shell; `classifyUndoGroupConflict` takes that decision as a plain boolean so
 * the branch logic — identical across all seven per-resourceType call sites —
 * lives in exactly one tested place.
 */
import { deepEqual } from './deep-equal';

/**
 * Field names whose current value differs from the recorded expected value.
 * Returns an empty list when either side is absent (nothing to compare).
 */
export function getConflictFields(
  expectedValues: Record<string, unknown> | null,
  currentValues: Record<string, unknown> | null
): string[] {
  if (!expectedValues || !currentValues) return [];
  return Object.entries(expectedValues).reduce<string[]>((acc, [key, value]) => {
    const currentVal = currentValues[key];
    if (!deepEqual(currentVal, value)) {
      acc.push(key);
    }
    return acc;
  }, []);
}

/**
 * True when applying targetValues would change nothing — every target field
 * already equals the current value. An empty target set is never a no-op.
 */
export function isNoOpChange(
  targetValues: Record<string, unknown> | null,
  currentValues: Record<string, unknown> | null
): boolean {
  if (!targetValues || !currentValues) return false;
  if (Object.keys(targetValues).length === 0) return false;
  return Object.entries(targetValues).every(([key, value]) =>
    deepEqual(currentValues[key], value)
  );
}

/**
 * Decide whether detected conflict fields are a real conflict or merely the
 * side effect of other activities within the same undo group.
 *
 * - No conflicts → return the (empty) list unchanged.
 * - No undo-group context → keep the conflicts (a plain rollback conflict).
 * - Undo group present but a later modification came from outside it → keep.
 * - Undo group present and the only later modifications were internal → clear:
 *   changes made by the group being undone are not conflicts.
 */
export function classifyUndoGroupConflict(params: {
  conflictFields: string[];
  hasUndoGroupContext: boolean;
  hasExternalModification: boolean;
}): string[] {
  const { conflictFields, hasUndoGroupContext, hasExternalModification } = params;
  if (conflictFields.length === 0) return conflictFields;
  if (!hasUndoGroupContext) return conflictFields;
  if (hasExternalModification) return conflictFields;
  return [];
}
