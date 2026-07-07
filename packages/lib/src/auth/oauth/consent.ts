/**
 * Consent-screen narration (ADR 0002 Decision 5). Pure — the caller resolves
 * drive/role names and role capability summaries server-side and passes them
 * in; this module never renders an id standalone, only alongside a name.
 *
 * @module @pagespace/lib/auth/oauth/consent
 */

import type { ParsedScope } from './scopes';

export interface ConsentNarrationContext {
  driveName?: string;
  roleName?: string;
  roleSummary?: string;
  /** The display name of the existing key an `update_key` scope re-scopes (caller resolves it; falls back to the token id). */
  keyName?: string;
}

/** Per-scope narration text (ADR 0002 Decision 5, point 3's table). */
export function describeScopeForConsent(scope: ParsedScope, ctx: ConsentNarrationContext): string {
  switch (scope.kind) {
    case 'account':
      return 'Full access to your PageSpace account — everything you can see and do, in every drive, now and in the future.';
    case 'offline_access':
      return 'Stay connected until you revoke access (issues a long-lived refresh credential).';
    case 'manage_keys':
      return 'Create and manage access keys on your behalf — cannot read or write any of your content directly.';
    case 'update_key': {
      const keyName = ctx.keyName ?? scope.tokenId;
      return `Update the drive access of your existing key "${keyName}" — the key itself and its secret stay the same; its access becomes exactly the list below.`;
    }
    case 'drive': {
      const driveName = ctx.driveName ?? scope.driveId;
      switch (scope.role.kind) {
        case 'inherit':
          return `Act as you in ${driveName} — everything you can currently do there (your access, including future changes to it). No access to any other drive.`;
        case 'admin':
          return `Full admin access to ${driveName} — view and edit all pages including private pages, manage sharing and deletion.`;
        case 'member':
          return `Member access to ${driveName} — view non-private pages and post in channels. Cannot edit other pages, share, or delete.`;
        case 'custom': {
          const roleName = ctx.roleName ?? scope.role.customRoleId;
          const summary = ctx.roleSummary ? ` (${ctx.roleSummary})` : '';
          return `Access to ${driveName} limited to the ${roleName} role${summary}.`;
        }
      }
    }
  }
}
