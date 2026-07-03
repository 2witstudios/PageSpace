/**
 * Pure functions for MCP token drive scope normalization.
 *
 * These functions have NO side effects — they transform input data into a
 * canonical shape that the repository and route handlers can consume.
 */

export interface DriveScopeInput {
  id: string;
  role?: 'ADMIN' | 'MEMBER' | null;
  customRoleId?: string;
}

/**
 * Normalize drive scope inputs from either the `drives` (preferred) or
 * `driveIds` (legacy) request body shape into a canonical array.
 *
 * Rules:
 * - `drives` and `driveIds` are mutually exclusive — throws if both are provided.
 * - `driveIds` maps to scopes with `role: null` (inherit owner's access).
 * - Duplicate drive IDs are deduplicated (last definition wins).
 *
 * @returns Canonical DriveScopeInput[] — never throws (except mutual-exclusivity violation).
 */
export function normalizeDriveScopes(
  drives?: DriveScopeInput[],
  driveIds?: string[]
): DriveScopeInput[] {
  if (drives && driveIds && drives.length > 0 && driveIds.length > 0) {
    throw new Error('Provide drives or driveIds, not both — they are mutually exclusive');
  }

  // Legacy: plain drive ID array → scopes with null role (inherit)
  if (driveIds && driveIds.length > 0) {
    const map = new Map<string, DriveScopeInput>();
    for (const id of driveIds) {
      map.set(id, { id, role: null });
    }
    return [...map.values()];
  }

  // Preferred: per-drive scope with optional role + customRoleId
  if (drives && drives.length > 0) {
    const map = new Map<string, DriveScopeInput>();
    for (const scope of drives) {
      map.set(scope.id, {
        id: scope.id,
        role: scope.role ?? null,
        customRoleId: scope.customRoleId,
      });
    }
    return [...map.values()];
  }

  return [];
}
