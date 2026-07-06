import { computeMcpTokenActionBinding, type NormalizedDriveScope } from '@pagespace/lib/auth/mcp-token-scopes';

/** A caller's chosen role for one drive in the create/edit dialogs' drive-scope picker. */
export interface DriveRoleSelection {
  role: 'ADMIN' | 'MEMBER' | null;
  customRoleId?: string | null;
}

function driveScopesForBinding(
  driveIds: string[],
  roleSelections: Record<string, DriveRoleSelection>,
): NormalizedDriveScope[] {
  return driveIds.map((id) => {
    const selection = roleSelections[id] ?? { role: null, customRoleId: null };
    return { id, role: selection.role, customRoleId: selection.customRoleId ?? undefined };
  });
}

/**
 * The action binding a POST /api/auth/mcp-tokens (mint) request must be
 * step-up gated on. Mirrors `computeMcpTokenActionBinding({ op: 'mint', ... })`
 * (`packages/lib/src/auth/mcp-token-scopes.ts`) exactly — reusing that same
 * pure function rather than re-deriving the hash shape here, so the two
 * sides can never drift out of sync.
 */
export function buildMintActionBinding(
  name: string,
  driveIds: string[],
  roleSelections: Record<string, DriveRoleSelection>,
): Record<string, string> {
  return computeMcpTokenActionBinding({ op: 'mint', name, driveScopes: driveScopesForBinding(driveIds, roleSelections) });
}

/**
 * The action binding a PATCH /api/auth/mcp-tokens/:tokenId (update) request
 * must be step-up gated on. Mirrors the server's `{ op: 'update', name: tokenId, ... }`
 * binding — `name` reuses the mint binding's identifying-string slot to scope
 * the grant to this specific token.
 */
export function buildUpdateActionBinding(
  tokenId: string,
  driveIds: string[],
  roleSelections: Record<string, DriveRoleSelection>,
): Record<string, string> {
  return computeMcpTokenActionBinding({
    op: 'update',
    name: tokenId,
    driveScopes: driveScopesForBinding(driveIds, roleSelections),
  });
}
