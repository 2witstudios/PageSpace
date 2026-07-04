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
}

/** Per-scope narration text (ADR 0002 Decision 5, point 3's table). */
export function describeScopeForConsent(scope: ParsedScope, ctx: ConsentNarrationContext): string {
  switch (scope.kind) {
    case 'account':
      return 'Full access to your PageSpace account — everything you can see and do, in every drive, now and in the future.';
    case 'offline_access':
      return 'Stay connected until you revoke access (issues a long-lived refresh credential).';
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
