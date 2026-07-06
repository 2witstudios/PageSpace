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

export interface NormalizedDriveScope {
  id: string;
  role: 'ADMIN' | 'MEMBER' | null;
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
 * @returns Canonical NormalizedDriveScope[] — never throws (except mutual-exclusivity violation).
 */
export function normalizeDriveScopes(
  drives?: DriveScopeInput[],
  driveIds?: string[]
): NormalizedDriveScope[] {
  if (drives && driveIds && drives.length > 0 && driveIds.length > 0) {
    throw new Error('Provide drives or driveIds, not both — they are mutually exclusive');
  }

  // Legacy: plain drive ID array → scopes with null role (inherit)
  if (driveIds && driveIds.length > 0) {
    const map = new Map<string, NormalizedDriveScope>();
    for (const id of driveIds) {
      map.set(id, { id, role: null });
    }
    return [...map.values()];
  }

  // Preferred: per-drive scope with optional role + customRoleId
  if (drives && drives.length > 0) {
    const map = new Map<string, NormalizedDriveScope>();
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

/**
 * Canonical, order-independent action-binding parts for an mcp-token mint/update
 * request (Phase 8 step-up gate). Fed into `computeActionBindingHash`
 * (`step-up-decisions.ts`) so a step-up grant obtained for one set of
 * name/drive-scope parameters can never be spent minting a different one.
 *
 * The drive-scope list is JSON-encoded (sorted `[id, role, customRoleId]`
 * tuples), never an ad-hoc delimiter join: `id` and `customRoleId` are plain
 * `z.string()` at the HTTP layer with no format validation for non-CLI
 * callers, and an unescaped join would let a smuggled `:`/`,` collapse two
 * different drive-scope sets to the same binding — see
 * `computeActionBindingHash`'s docstring for the same reasoning.
 */
export function computeMcpTokenActionBinding({
  name,
  driveScopes,
}: {
  name: string;
  driveScopes: NormalizedDriveScope[];
}): Record<string, string> {
  const canonicalDrives = JSON.stringify(
    [...driveScopes]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((scope) => [scope.id, scope.role ?? '', scope.customRoleId ?? '']),
  );
  return { name, driveScopes: canonicalDrives };
}
