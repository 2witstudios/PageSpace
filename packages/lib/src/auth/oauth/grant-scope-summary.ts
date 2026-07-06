/**
 * Human-readable scope summaries for the connected-apps listing page (Phase
 * 8 task k58h61obmc91sn1ndngrsev5). Pure over already-fetched data: the
 * caller resolves drive/custom-role names server-side and passes them in as
 * lookup maps; this reuses `describeScopeForConsent` per scope (the OAuth
 * consent screen's own formatter) rather than reinventing scope-to-text
 * narration for a second surface.
 *
 * @module @pagespace/lib/auth/oauth/grant-scope-summary
 */

import { parseScopeList } from './scopes';
import { describeScopeForConsent } from './consent';

export interface GrantScopeNameResolvers {
  readonly driveNamesById: ReadonlyMap<string, string>;
  readonly roleNamesById: ReadonlyMap<string, { name: string; description: string | null }>;
}

/** A stored grant's scopes were validated at consent time — a parse failure here only matters as a fail-safe. */
export function describeGrantScopes(scopes: readonly string[], resolvers: GrantScopeNameResolvers): string[] {
  const parsed = parseScopeList(scopes.join(' '));
  if (!parsed.ok) return [];

  const descriptions: string[] = [];
  if (parsed.scopes.account) {
    descriptions.push(describeScopeForConsent({ kind: 'account' }, {}));
  }
  if (parsed.scopes.offlineAccess) {
    descriptions.push(describeScopeForConsent({ kind: 'offline_access' }, {}));
  }
  for (const scope of parsed.scopes.drives.values()) {
    const driveName = resolvers.driveNamesById.get(scope.driveId);
    if (scope.role.kind === 'custom') {
      const role = resolvers.roleNamesById.get(scope.role.customRoleId);
      descriptions.push(
        describeScopeForConsent(scope, { driveName, roleName: role?.name, roleSummary: role?.description ?? undefined }),
      );
    } else {
      descriptions.push(describeScopeForConsent(scope, { driveName }));
    }
  }
  return descriptions;
}
