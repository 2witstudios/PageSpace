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
  /**
   * Affirms that `profile` is the ONLY access-bearing scope in the grant being
   * narrated — no `drive:*`, no `account`, no `all_drives`.
   *
   * "No access to any drive or content" is a claim about the SET, and this is a
   * per-scope formatter, so it cannot learn that on its own; the caller holds
   * the set and must say so. Deliberately opt-IN: absent means the narration
   * falls back to the identity sentence alone, which is true of every profile
   * grant. A caller that forgets the flag therefore under-claims rather than
   * lying — and the lie is the expensive direction, because the screen this
   * text renders on is part of the security boundary (ADR 0002 Decision 5).
   */
  profileIsSoleAccess?: boolean;
}

/** Per-scope narration text (ADR 0002 Decision 5, point 3's table). */
export function describeScopeForConsent(scope: ParsedScope, ctx: ConsentNarrationContext): string {
  switch (scope.kind) {
    case 'account':
      return 'Full access to your PageSpace account — everything you can see and do, in every drive, now and in the future.';
    case 'profile':
      // Identity only (ADR 0004 Decision 4). The second sentence is
      // contractual, not decoration: `profile` is the one scope approved
      // without the step-up ceremony, so when it IS the whole grant the screen
      // must state plainly that nothing content-bearing is being handed over.
      // It is withheld otherwise — `profile drive:abc123` is a legal grant, and
      // rendering the absolute claim above "Act as you in Acme Drive" is a
      // contradiction on the one surface that has to be trustworthy.
      return ctx.profileIsSoleAccess
        ? 'See your name, email, and avatar. No access to any drive or content.'
        : 'See your name, email, and avatar.';
    case 'offline_access':
      return 'Stay connected until you revoke access (issues a long-lived refresh credential).';
    case 'manage_keys':
      return 'Create and manage access keys on your behalf — cannot read or write any of your content directly.';
    case 'name':
      return `Name this key "${scope.name}" — shown in \`pagespace keys list\` and to anyone else with access to this account's key list.`;
    case 'all_drives':
      return 'Access to all your drives, including any created later — the maximum grant for a drive-scoped key.';
    case 'update_key': {
      const keyName = ctx.keyName ?? scope.tokenId;
      return `Update the drive access of your existing key "${keyName}" — the key itself and its secret stay the same; its access becomes exactly the list below.`;
    }
    case 'activate_key': {
      const keyName = ctx.keyName ?? scope.tokenId;
      return `Make "${keyName}" the active key on the device that sent you here — commands there run with this key's existing access until you switch or deactivate it. Nothing about the key or its access changes.`;
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
