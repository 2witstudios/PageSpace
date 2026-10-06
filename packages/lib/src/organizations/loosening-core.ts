/**
 * [D-OW-33] "Does this change LOOSEN access?" — the pure rules behind every write a lapsed org may not make (SEAT-9 as
 * amended: a lapsed org may only restrict). No IO, client-safe. The write sites read the state before and after (or
 * the state and the request) and ask these; `checkOrgMayLoosen` then refuses a loosening change while lapsed.
 *
 * What a drive member reaches (mirrors resolveExplicitAppRoleAccess, app-permissions.ts):
 *   - OWNER / ADMIN: everything;
 *   - MEMBER with a custom role: the role's per-page entry for a page, else its drive-wide grant (never on a private
 *     page), else nothing;
 *   - plain MEMBER (no custom role): view of every non-private page, edit of channels;
 *   - GUEST: its explicit page grants only.
 * Page grants (page_permissions) add on top of any of these.
 *
 * Each rule FAILS CLOSED: when it cannot prove a change only restricts (a page's privacy is not known here), it calls
 * the change loosening. A lapsed org is then refused a change that might have been a tightening — never the reverse.
 */

export type GrantFlags = { canView: boolean; canEdit: boolean; canShare: boolean };
export type PageGrantFlags = GrantFlags & { canDelete: boolean };

/** A drive role's grants, as stored on drive_roles (permissions, driveWidePermissions). */
export interface RoleGrant {
  permissions: Record<string, GrantFlags>;
  driveWidePermissions: GrantFlags | null;
}

export type DriveMemberRoleName = 'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST';

/** What one person holds on a drive through their member row, with the custom role resolved (null: none). */
export interface MemberAccess {
  role: DriveMemberRoleName;
  customRole: RoleGrant | null;
}

const FLAGS = ['canView', 'canEdit', 'canShare'] as const;
const PAGE_FLAGS = ['canView', 'canEdit', 'canShare', 'canDelete'] as const;

const ROLE_RANK: Readonly<Record<DriveMemberRoleName, number>> = { GUEST: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 };

const EMPTY_ROLE: RoleGrant = { permissions: {}, driveWidePermissions: null };

const has = (g: Partial<GrantFlags> | null | undefined, f: (typeof FLAGS)[number]): boolean => g?.[f] === true;

/**
 * Does role `to` grant anything role `from` did not (null: no role, nothing)? Flag by flag:
 *   - a drive-wide flag `to` gains;
 *   - a page `to` lists with a flag `from` did not list on that page (the page may be private, where `from`'s
 *     drive-wide grant never reached, so only `from`'s own entry counts);
 *   - a page `from` listed but `to` does not: `to`'s drive-wide grant now falls through onto it.
 */
export function roleGrantWidens(from: RoleGrant | null, to: RoleGrant | null): boolean {
  const a = from ?? EMPTY_ROLE;
  const b = to ?? EMPTY_ROLE;
  if (FLAGS.some((f) => has(b.driveWidePermissions, f) && !has(a.driveWidePermissions, f))) return true;
  for (const [pageId, entry] of Object.entries(b.permissions ?? {})) {
    if (FLAGS.some((f) => has(entry, f) && !has(a.permissions?.[pageId], f))) return true;
  }
  for (const [pageId, entry] of Object.entries(a.permissions ?? {})) {
    if (b.permissions?.[pageId] !== undefined) continue;
    if (FLAGS.some((f) => has(b.driveWidePermissions, f) && !has(entry, f))) return true;
  }
  return false;
}

/** A custom role that reaches no further than the plain member role: no page entry grants anything, drive-wide at most view. */
function customRoleWithinPlainMember(r: RoleGrant): boolean {
  if (has(r.driveWidePermissions, 'canEdit') || has(r.driveWidePermissions, 'canShare')) return false;
  return Object.values(r.permissions ?? {}).every((entry) => !FLAGS.some((f) => has(entry, f)));
}

/** A custom role that already viewed and edited everywhere it reached: the plain member role gives no more. */
function customRoleCoversPlainMember(r: RoleGrant): boolean {
  if (!has(r.driveWidePermissions, 'canView') || !has(r.driveWidePermissions, 'canEdit')) return false;
  return Object.values(r.permissions ?? {}).every((entry) => has(entry, 'canView') && has(entry, 'canEdit'));
}

/** Does moving a person from `from` (null: no accepted row, nothing) to `to` give them more on the drive? */
export function memberAccessWidens(from: MemberAccess | null, to: MemberAccess): boolean {
  if (from === null) return true;
  if (ROLE_RANK[to.role] > ROLE_RANK[from.role]) return true;
  if (ROLE_RANK[to.role] < ROLE_RANK[from.role]) return false;
  // Same role. OWNER and ADMIN reach everything whatever the custom role; a GUEST holds page grants only.
  if (to.role !== 'MEMBER') return false;
  if (from.customRole === null && to.customRole === null) return false;
  if (from.customRole === null) return !customRoleWithinPlainMember(to.customRole as RoleGrant);
  if (to.customRole === null) return !customRoleCoversPlainMember(from.customRole);
  return roleGrantWidens(from.customRole, to.customRole);
}

/** Does writing `next` give a person more on a page than `existing` (null: no grant)? Includes canDelete. */
export function pageFlagsWiden(existing: PageGrantFlags | null, next: PageGrantFlags): boolean {
  return PAGE_FLAGS.some((flag) => next[flag] && !existing?.[flag]);
}

export type OrgDriveVisibilityName = 'PRIVATE' | 'RESTRICTED' | 'OPEN';
const OPENNESS: Readonly<Record<OrgDriveVisibilityName, number>> = { PRIVATE: 0, RESTRICTED: 1, OPEN: 2 };

/**
 * Everything on one drive that decides who reaches it, as the write sites snapshot it (in their transaction) before
 * and after a write. A snapshot may be SCOPED (only some members, no grants): both sides of a comparison use the
 * same scope.
 */
export interface DriveAccessSnapshot {
  /** `leadId` is drives.ownerId: who leads the drive. */
  drive: { leadId: string; orgId: string | null; orgVisibility: OrgDriveVisibilityName } | null;
  /** By user id. `accepted: false` is a pending invitation, which grants nothing. */
  members: Record<string, { role: DriveMemberRoleName; customRoleId: string | null; accepted: boolean }>;
  /** By `${pageId}:${userId}`. */
  grants: Record<string, PageGrantFlags>;
  /** By role id. */
  roles: Record<string, { grant: RoleGrant; isDefault: boolean }>;
  /** Agents that are members of this drive, by agent page id. Everyone who can use the agent reads through it. */
  agents: Record<string, { role: DriveMemberRoleName; customRoleId: string | null; includeContext: boolean }>;
  /**
   * MCP token (app) scopes on this drive, by token id (mcp_token_drives). `role: null` is INHERIT: the token acts
   * with its owner's access here. An explicit role means what it means for a member, private pages included.
   */
  tokens: Record<string, TokenScope>;
  /** `isPrivate` of the pages a write can touch (scoped; usually none). */
  pagePrivacy: Record<string, boolean>;
}

export interface TokenScope {
  role: DriveMemberRoleName | null;
  customRoleId: string | null;
}

/**
 * Does moving a token's scope from `from` (undefined: no scope) to `to` give it more on the drive? INHERIT is bounded
 * by the owner's access, which this rule cannot see, so it fails closed: an explicit ADMIN is at least INHERIT (no
 * one reaches more than an Admin), and anything else moving to or from INHERIT counts as widening.
 */
export function tokenScopeWidens(
  from: TokenScope | undefined,
  to: TokenScope,
  roles: { before: DriveAccessSnapshot['roles']; after: DriveAccessSnapshot['roles'] },
): boolean {
  if (!from) return true;
  if (to.role === null) return !(from.role === null || from.role === 'ADMIN' || from.role === 'OWNER');
  if (from.role === null) return true;
  return memberAccessWidens(
    resolveAccess({ role: from.role, customRoleId: from.customRoleId }, roles.before),
    resolveAccess({ role: to.role, customRoleId: to.customRoleId }, roles.after),
  );
}

/** The drive's default custom role (the lowest id among defaults, for a deterministic pick), or null: the plain role. */
function defaultRoleGrant(roles: DriveAccessSnapshot['roles']): RoleGrant | null {
  const id = Object.keys(roles).filter((k) => roles[k].isDefault).sort()[0];
  return id === undefined ? null : roles[id].grant;
}

function resolveAccess(
  row: { role: DriveMemberRoleName; customRoleId: string | null },
  roles: DriveAccessSnapshot['roles'],
): MemberAccess {
  // A custom role id that does not resolve grants nothing (the resolver's customRoleUnresolved).
  const customRole = row.customRoleId === null ? null : (roles[row.customRoleId]?.grant ?? EMPTY_ROLE);
  return { role: row.role, customRole };
}

/**
 * [D-OW-33] Did a write give anyone more on the drive? Compares two snapshots taken in the write's transaction:
 *   - the drive: a new lead, a move between orgs, or a more open visibility;
 *   - each member: a new or newly accepted row, or more than before (memberAccessWidens) — a role's widening counts
 *     only through the people holding it, so editing an unused role loosens nothing;
 *   - each page grant: a flag gained;
 *   - each agent membership: a new one, more than before, or its drive context newly included;
 *   - an OPEN org drive's default role made wider (its org members hold it implicitly);
 *   - each token (app) scope: a new one, or more than before (tokenScopeWidens);
 *   - a page made non-private.
 */
export function driveAccessWidens(before: DriveAccessSnapshot, after: DriveAccessSnapshot): boolean {
  const b = before.drive;
  const a = after.drive;
  if (a && b) {
    if (a.leadId !== b.leadId || a.orgId !== b.orgId) return true;
    if (OPENNESS[a.orgVisibility] > OPENNESS[b.orgVisibility]) return true;
  } else if (a && !b) {
    return true;
  }

  for (const [userId, row] of Object.entries(after.members)) {
    if (!row.accepted) continue;
    const prior = before.members[userId];
    const from = prior && prior.accepted ? resolveAccess(prior, before.roles) : null;
    if (memberAccessWidens(from, resolveAccess(row, after.roles))) return true;
  }

  for (const [key, flags] of Object.entries(after.grants)) {
    if (pageFlagsWiden(before.grants[key] ?? null, flags)) return true;
  }

  // An OPEN org drive's org members hold its default role implicitly (with or without a materialized row), so a wider
  // default reaches people no member row shows: fail closed and count it.
  if (a?.orgId && a.orgVisibility === 'OPEN' &&
    memberAccessWidens({ role: 'MEMBER', customRole: defaultRoleGrant(before.roles) }, { role: 'MEMBER', customRole: defaultRoleGrant(after.roles) })) {
    return true;
  }

  for (const [tokenId, scope] of Object.entries(after.tokens)) {
    if (tokenScopeWidens(before.tokens[tokenId], scope, { before: before.roles, after: after.roles })) return true;
  }

  for (const [pageId, isPrivate] of Object.entries(after.pagePrivacy)) {
    if (before.pagePrivacy[pageId] === true && !isPrivate) return true;
  }

  for (const [agentId, row] of Object.entries(after.agents)) {
    const prior = before.agents[agentId];
    if (!prior) return true;
    if (row.includeContext && !prior.includeContext) return true;
    if (memberAccessWidens(resolveAccess(prior, before.roles), resolveAccess(row, after.roles))) return true;
  }
  return false;
}
