/**
 * WHICH ORGANIZATION AND WALLET ROWS A TENANT BUNDLE CARRIES (Spec X-3) — the
 * exporter's rule, in one place so `tenant-validate` asks exactly the question
 * the export answered (the same reason `conversationSelectionWhere` and
 * `contentTagSelectionWhere` exist).
 *
 * WHAT THE ROWS MEAN ON A TENANT. A tenant deployment runs with billing OFF
 * (`isBillingEnabled()` is false for DEPLOYMENT_MODE=tenant): every org reads
 * active whatever its subscription says, and the credit gate neither checks
 * nor debits wallets. So subscriptions, funding proof, balances, debt and caps
 * are carried as DATA — the record of the team's money, and what a later move
 * back to a billed deployment would need — and enforced by nothing on the
 * tenant. Nothing below may rely on billing to fail closed there.
 *
 * Two kinds of carried org, and the difference is what can ADD access or hold
 * money:
 *
 *  - A MIGRATING org: its Owner is one of the requested users. The team is
 *    moving, so the org moves whole — identity and policies, members, open
 *    invitations, verified domains, departure suppressions, the Business
 *    subscription and its funding proof, and every wallet it owns (pool, drive
 *    and agent wallets, with their funding legs, caps and notice state).
 *  - A REFERENCED org: carried only because a carried drive names it
 *    (`drives.orgId` is a RESTRICT FK, so the drive cannot land without it) or
 *    a requested user is a member, while its Owner stays behind. It travels as
 *    identity, policies, the exported users' memberships and departures — what
 *    the tenant needs to resolve access to the drive exactly as the source did —
 *    plus its departure suppressions, and nothing that adds access or holds
 *    money: no invitations, no domains (a verified domain would auto-join tenant
 *    users into another team's org), no subscription, no wallets (a second copy
 *    of a pool the source still spends).
 *
 * SUPPRESSIONS TRAVEL FOR EVERY CARRIED ORG [D-OW-27]. A referenced org reads
 * ACTIVE on the tenant, and its Owner or an Admin there can re-add and verify a
 * domain; from then on the suppression is the only thing that keeps a person
 * who left the org from being auto-joined back. Suppressions are keyed hashes
 * (no address, no user id) and can only ever refuse a join, so carrying them
 * adds no access and no personal data.
 *
 * Personal wallets travel with their REQUESTED owner only. A discovered user
 * (a conversation owner, a channel author, a drive or org Owner) is carried as
 * a row so references resolve, but stays live on the source, so their balance
 * must not be duplicated into the tenant.
 *
 * The ledger (`credit_ledger`) and in-flight holds (`credit_holds`) do not
 * travel — see TENANT_EXPORT_EXCLUDED_TABLES for why.
 */

/** An id list already rendered for SQL (`toSqlInList`). */
type SqlInList = string;

/** The id lists every org/wallet predicate is scoped by. */
export interface OrgWalletScope {
  /** Drives the bundle carries. */
  driveIn: SqlInList;
  /** Every user the bundle carries: requested plus discovered. */
  allUserIn: SqlInList;
  /** Every org the bundle carries, migrating or referenced. */
  orgIn: SqlInList;
  /** The orgs whose Owner is a requested user. */
  migratingOrgIn: SqlInList;
  /** Wallets the bundle carries (`keptWalletIds`). */
  walletIn: SqlInList;
}

/** The orgs a bundle carries: every org a carried drive names, and every org a requested user belongs to. */
export function orgSelectionWhere(driveIn: SqlInList, requestedUserIn: SqlInList): string {
  return `id IN (SELECT "orgId" FROM drives WHERE id IN (${driveIn}) AND "orgId" IS NOT NULL)`
    + ` OR id IN (SELECT "orgId" FROM org_members WHERE "userId" IN (${requestedUserIn}))`;
}

/** A carried org's Owner is a requested user: the org migrates whole, money included. */
export function migratingOrgIds(
  orgs: readonly { id: string; ownerId: string }[],
  requestedUserIds: ReadonlySet<string>,
): string[] {
  return orgs.filter((org) => requestedUserIds.has(org.ownerId)).map((org) => org.id).sort();
}

/** Wallets that may travel before the subject/parent closure: requested users' own, and migrating orgs'. */
export function walletCandidateWhere(requestedUserIn: SqlInList, migratingOrgIn: SqlInList): string {
  return `("ownerType" = 'user' AND "userId" IN (${requestedUserIn}))`
    + ` OR ("ownerType" = 'org' AND "orgId" IN (${migratingOrgIn}))`;
}

export interface WalletRef {
  id: string;
  subjectType: string | null;
  subjectId: string | null;
  parentWalletId: string | null;
}

/**
 * The candidate wallets that actually travel. A subject wallet goes only with
 * its subject (a drive or agent page the bundle carries — `subjectId` has no
 * FK, so nothing else would stop a wallet for a drive left behind), and a child
 * only with its parent (`parentWalletId` is a FK; an allocation is drawn
 * against its parent, so re-rooting it would change what it spends). Iterated
 * to a fixpoint, since dropping a wallet drops its children. Sorted, so the
 * bundle is deterministic.
 */
export function keptWalletIds(
  candidates: readonly WalletRef[],
  bundle: { driveIds: ReadonlySet<string>; pageIds: ReadonlySet<string> },
): string[] {
  const subjectCarried = (w: WalletRef): boolean =>
    w.subjectType === null
    || (w.subjectType === 'drive' && w.subjectId !== null && bundle.driveIds.has(w.subjectId))
    || (w.subjectType === 'agent_page' && w.subjectId !== null && bundle.pageIds.has(w.subjectId));

  let kept = new Set(candidates.filter(subjectCarried).map((w) => w.id));
  for (;;) {
    const next = new Set(
      candidates
        .filter((w) => kept.has(w.id) && (w.parentWalletId === null || kept.has(w.parentWalletId)))
        .map((w) => w.id),
    );
    if (next.size === kept.size) break;
    kept = next;
  }
  return [...kept].sort();
}

/** The org/wallet tables whose rows the bundle selects by a scope predicate. */
export type ScopedOrgWalletTable =
  | 'org_members'
  | 'org_invitations'
  | 'org_subscriptions'
  | 'org_subscription_funding'
  | 'org_domains'
  | 'org_member_departures'
  | 'org_departure_suppressions'
  | 'org_guest_holds'
  | 'drive_join_requests'
  | 'wallets'
  | 'wallet_funding_legs'
  | 'wallet_consumer_caps'
  | 'wallet_debt_notices'
  | 'wallet_cap_alerts'
  | 'drive_spend_overrides'
  | 'automation_skip_notices';

/** The WHERE predicate selecting each scoped table's carried rows — shared by export and validate. */
export function orgWalletSelectionWhere(table: ScopedOrgWalletTable, s: OrgWalletScope): string {
  switch (table) {
    // Membership facts of the people the bundle carries, in any carried org.
    case 'org_members':
    case 'org_member_departures':
      return `"orgId" IN (${s.orgIn}) AND "userId" IN (${s.allUserIn})`;
    // Refuses only, never grants: every carried org (see the module header, D-OW-27).
    case 'org_departure_suppressions':
      return `"orgId" IN (${s.orgIn})`;
    // What adds access or holds money: migrating orgs only (see the module header).
    case 'org_invitations':
    case 'org_subscriptions':
    case 'org_subscription_funding':
    case 'org_domains':
      return `"orgId" IN (${s.migratingOrgIn})`;
    // A hold names a person (userId) or an address (email), never both; a held person must travel.
    case 'org_guest_holds':
      return `"orgId" IN (${s.orgIn}) AND "driveId" IN (${s.driveIn})`
        + ` AND ("userId" IS NULL OR "userId" IN (${s.allUserIn}))`;
    case 'drive_join_requests':
    case 'drive_spend_overrides':
      return `"driveId" IN (${s.driveIn}) AND "userId" IN (${s.allUserIn})`;
    case 'automation_skip_notices':
      return `"driveId" IN (${s.driveIn})`;
    case 'wallets':
      return `id IN (${s.walletIn})`;
    case 'wallet_funding_legs':
    case 'wallet_consumer_caps':
    case 'wallet_debt_notices':
    case 'wallet_cap_alerts':
      return `"walletId" IN (${s.walletIn})`;
  }
}
