import { pgTable, text, integer, timestamp, index, pgEnum, check } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';
import { pages, drives } from './core';

/**
 * The lifecycle of a published app, as a state machine.
 *
 *   provisioning → building → deploying → running ⇄ stopped
 *                                            ↓         ↓
 *                                          parked ←────┘
 *   (any) → destroying → (row deleted)
 *   (any) → failed
 *
 * `stopped` is US stopping an idle app (the metering boundary — see lastStopAt);
 * `parked` is the credit gate refusing to wake it. The distinction matters because
 * a stopped app wakes on the next request and a parked one does NOT: parking is
 * enforcement, and the router serves a parked page instead of starting a machine.
 */
export const publishedAppStatus = pgEnum('published_app_status', [
  'provisioning',
  'building',
  'deploying',
  'running',
  'stopped',
  'parked',
  'destroying',
  'failed',
]);
export type PublishedAppStatus = (typeof publishedAppStatus.enumValues)[number];

/**
 * 'metered' drains credits per awake-second and is subject to the balance gate.
 * 'dedicated' is the flat monthly SKU: same pipeline, minus the gate, exempt from
 * the idle reaper. The tier is the ONLY difference between the two products.
 */
export const publishedAppTier = pgEnum('published_app_tier', ['metered', 'dedicated']);
export type PublishedAppTier = (typeof publishedAppTier.enumValues)[number];

/**
 * publishedApps — one row per user app published to real hosting, one Fly app each.
 *
 * The row is the SOURCE OF TRUTH FOR A BILLING RESOURCE, and it is written BEFORE
 * the Fly app exists. That ordering is the whole safety property: a crash between
 * "we inserted the row" and "Fly created the app" leaves a harmless orphan row we
 * can retry or reap, whereas the reverse ordering would leave a Fly app that bills
 * forever with nothing in our database pointing at it. Never reorder those two
 * steps, and never delete a row because provisioning failed — `flyAppName` is
 * derived from `id` and is the only handle that can destroy the Fly app, so a row
 * deleted after a partial create strands exactly the resource it was tracking.
 * (Deleting it is in fact safe TODAY, but only because the AFTER DELETE trigger
 * below rescues the name into `app_hosting_reclaims` first. Don't rely on that as
 * a design; rely on not deleting.)
 *
 * NETWORK: every published app is created on ONE SHARED Fly network, never a
 * per-app one. Per-app 6PN isolation was the original design (epic decision D2)
 * and the Phase 0 spike refuted it: fly-replay cannot cross networks — the proxy
 * answers 502 `cross-network replays are not allowed` — which would break the
 * entire routing tier. `networkName` here is an AUDIT column recording what an app
 * was actually created with, so a later change to the shared-network constant is
 * visible per app. Its value always comes from that constant; nothing derives a
 * network from the app id.
 */
export const publishedApps = pgTable('published_apps', {
  /**
   * Generated client-side (cuid2) so it exists BEFORE the first Fly API call —
   * `flyAppName` is derived from it, which is what lets us name the resource we
   * are about to create and record the name in the same transaction.
   */
  id: text('id').primaryKey().$defaultFn(() => createId()),

  /** The page being published. One published app per page. */
  pageId: text('pageId').notNull().unique().references(() => pages.id, { onDelete: 'cascade' }),

  /**
   * Denormalized from the page so the claim and metering queries don't join
   * through `pages` on every tick. Cascades independently: a permanent drive
   * delete must reach this row even if the page rows go first.
   */
  driveId: text('driveId').notNull().references(() => drives.id, { onDelete: 'cascade' }),

  /** Who pays. Resolved drive-owner-else-app-owner, matching `resolveSessionPayerId` semantics. */
  ownerId: text('ownerId').notNull().references(() => users.id, { onDelete: 'cascade' }),

  /**
   * The Fly app name (`pgs-app-<id>`) — globally unique, and the ONLY handle that
   * can destroy the Fly app. This is the value the reclaim outbox rescues when the
   * row dies.
   */
  flyAppName: text('flyAppName').notNull().unique(),

  /**
   * The Fly network this app was created on. AUDIT ONLY — always written from the
   * single shared-network constant, never derived per app. See the table docblock
   * for why per-app networks are forbidden.
   */
  networkName: text('networkName').notNull(),

  /**
   * Served as `<subdomain>.<published-apps apex>`. Its own namespace: published
   * apps get a separate PSL-listed apex from `drives.publishSubdomain` (which
   * lives on `*.pagespace.site`), so a collision across the two is not possible
   * and is not defended against here.
   */
  subdomain: text('subdomain').notNull().unique(),

  status: publishedAppStatus('status').default('provisioning').notNull(),

  /**
   * Fixed small guest for v1 (shared-1x/512MB): the unit-economics guardrail that
   * bounds worst-case cost per app. The CHECK below is the enforcement of that
   * decision — widening the allowed set later is an additive migration.
   */
  guestPreset: text('guestPreset').default('shared-cpu-1x-512').notNull(),

  /**
   * The pinned `sha256:…` digest this app serves. NULL until the first build lands.
   * Deploys are blue/green from a pinned digest — never in-place config surgery —
   * because a machine's rootfs assembles at CREATE, not at start.
   */
  imageDigest: text('imageDigest'),

  tier: publishedAppTier('tier').default('metered').notNull(),

  /** The current Fly machine. NULL before the first create and between blue/green swaps. */
  machineId: text('machineId'),

  /**
   * The awake-seconds boundaries. Our orchestrator owns every start/stop (autostop
   * is off) precisely so these are exact API-call timestamps rather than inferred
   * from proxy behavior — they are what the credit drain bills against.
   */
  lastWakeAt: timestamp('lastWakeAt', { mode: 'date', withTimezone: true }),
  lastStopAt: timestamp('lastStopAt', { mode: 'date', withTimezone: true }),

  /** Why a `failed` row failed — the operator's first read when an app won't provision. */
  lastError: text('lastError'),

  createdAt: timestamp('createdAt', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date', withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
}, (table) => ({
  driveIdx: index('published_apps_drive_idx').on(table.driveId),
  ownerIdx: index('published_apps_owner_idx').on(table.ownerId),
  // The claim query's access path: "oldest rows in these statuses, skip-locked".
  statusIdx: index('published_apps_status_idx').on(table.status, table.updatedAt),

  // Enforce the coherence a bad write could otherwise manufacture — each of these
  // states would be read by the router or the metering cron as real, servable truth.

  // A machine cannot serve an image we never pinned. A `running` row with no digest
  // means we lost track of what code is live, which is unrecoverable by inspection.
  servingRequiresImage: check(
    'published_apps_serving_requires_image',
    sql`${table.status} NOT IN ('running', 'deploying') OR ${table.imageDigest} IS NOT NULL`,
  ),
  // A `running` row with no machineId is an app we are billing and cannot stop.
  runningRequiresMachine: check(
    'published_apps_running_requires_machine',
    sql`${table.status} <> 'running' OR ${table.machineId} IS NOT NULL`,
  ),
  // Parking IS the credit-exhaustion state, and a dedicated app skips the balance
  // gate by definition — so a parked dedicated row describes an enforcement action
  // that cannot have happened.
  parkedIsMeteredOnly: check(
    'published_apps_parked_is_metered_only',
    sql`${table.status} <> 'parked' OR ${table.tier} = 'metered'`,
  ),
  // v1 ships exactly one guest size; this is where that decision is enforced rather
  // than merely documented.
  guestPresetAllowed: check(
    'published_apps_guest_preset_allowed',
    sql`${table.guestPreset} IN ('shared-cpu-1x-512')`,
  ),
  subdomainNonEmpty: check(
    'published_apps_subdomain_nonempty',
    sql`length(${table.subdomain}) > 0`,
  ),
}));

/**
 * appDeployTokenMints — the audit trail for per-app Fly deploy tokens.
 *
 * `POST /v1/apps/{app}/deploy_token` mints a credential whose blast radius is
 * exactly one app: full machine CRUD on its own app, 403 on every sibling app, on
 * the org list, and on app create (verified by the Phase 0 spike). That makes it
 * a safe thing to hand a build job. Two properties make a mint record mandatory:
 *
 *   1. The response is `{"token": "FlyV1 fm2_…,fm2_…"}` and NOTHING else — no id,
 *      no expires_at, no metadata. Fly gives us no handle to the token it just
 *      created, so THIS TABLE IS THE ONLY RECORD THAT A MINT EVER HAPPENED.
 *   2. A deploy token can mint a new deploy token for its own app. A leaked one
 *      therefore extends its own life indefinitely, and revocation has to happen
 *      at the app level — destroying the Fly app is the kill switch. "How many
 *      tokens exist for this app and why" is consequently a security question.
 *
 * A side table rather than columns on `published_apps` because minting repeats
 * (build, rotation, renewal) and a single-row overwrite would erase exactly the
 * history being kept.
 *
 * The TOKEN VALUE IS NEVER STORED. It is returned to the caller and forgotten;
 * persisting a self-renewing app-scoped credential would turn this audit table
 * into a breach target worth more than the app it protects.
 */
export const appDeployTokenMints = pgTable('app_deploy_token_mints', {
  id: text('id').primaryKey().$defaultFn(() => createId()),

  publishedAppId: text('publishedAppId')
    .notNull()
    .references(() => publishedApps.id, { onDelete: 'cascade' }),

  /** Denormalized: the exact blast radius of the token that was minted. */
  flyAppName: text('flyAppName').notNull(),

  mintedAt: timestamp('mintedAt', { mode: 'date', withTimezone: true }).defaultNow().notNull(),

  /**
   * The `expiry` string sent to Fly, verbatim (e.g. '48h'). Fly echoes nothing
   * back, so this is our only record of the lifetime we asked for — and thus the
   * only basis for deciding a mint is old enough to be worth worrying about.
   */
  expiry: text('expiry').notNull(),

  /** Why it was minted ('build' | 'rotate') — the question an audit record has to answer. */
  purpose: text('purpose').notNull(),
}, (table) => ({
  appIdx: index('app_deploy_token_mints_app_idx').on(table.publishedAppId, table.mintedAt),
  expiryNonEmpty: check('app_deploy_token_mints_expiry_nonempty', sql`length(${table.expiry}) > 0`),
  purposeNonEmpty: check('app_deploy_token_mints_purpose_nonempty', sql`length(${table.purpose}) > 0`),
}));

/**
 * appHostingReclaims — the teardown OUTBOX for published Fly apps.
 *
 * A published Fly app is a real, billing resource. The only way to find one is its
 * `flyAppName`, and that name lives on `published_apps` — which FK-cascades off
 * `pages.id` AND `drives.id` (and through them off `users.id`). So every path that
 * hard-deletes a page or a drive destroys the only pointer to an app that may still
 * be serving and billing: the 30-day GDPR purge, "delete permanently" from the
 * trash, a permanent drive delete, the account-erasure worker, and any path someone
 * adds tomorrow. This is not hypothetical — the Sprites equivalent of exactly this
 * bug put a stuck, unreferenced microVM into production that had to be killed by
 * hand, which is why `machine_sprite_reclaims` exists and why this table copies it.
 *
 * Guarding each delete path is the obvious fix and it is the WRONG one: it is
 * unenforceable (there is always one more path), and it cannot work for erasure —
 * GDPR Art. 17 must not be blocked by a Fly app we failed to kill.
 *
 * So this table inverts the dependency. It holds nothing but a name, and it has NO
 * FOREIGN KEYS — nothing can cascade it away. An `AFTER DELETE` trigger on
 * `published_apps` copies the name in here as the row is destroyed. Postgres fires
 * row-level triggers for rows deleted by a referential CASCADE exactly as it does
 * for a direct DELETE, so ONE trigger on `published_apps` captures the name no
 * matter which table's delete started it — a page purge, a drive delete, a user
 * erasure, or a hand-run `DELETE FROM published_apps` in psql. The insert is part
 * of the deleting transaction: either the pointer moves here, or the delete does
 * not commit.
 *
 * The pointer therefore OUTLIVES the resource, which is the invariant that matters.
 * The drain cron (epic Phase 5) destroys the Fly app with an idempotent kill and
 * removes each row only once the app is CONFIRMED gone — so a failed kill is
 * retried forever rather than forgotten.
 */
export const appHostingReclaims = pgTable('app_hosting_reclaims', {
  /**
   * The Fly app to destroy. PRIMARY KEY, so the trigger can `ON CONFLICT`: the same
   * app enqueued twice (a re-delete after a failed kill) is one unit of work.
   */
  flyAppName: text('flyAppName').primaryKey(),

  /**
   * The `published_apps` row that died. Provenance only, and deliberately NOT a
   * foreign key — an FK here would let the very cascade this table exists to
   * survive delete the rescued pointer.
   */
  publishedAppId: text('publishedAppId'),

  /**
   * The machine that was live when this pointer was rescued. The kill is
   * NAME-keyed and a Fly app name could be re-created later, so this is the
   * reconciler's identity guard: destroy the app at this name only if it is still
   * the one we meant. NULL when the app had no machine yet (destroy is then
   * unambiguous — there is nothing running to protect).
   */
  machineId: text('machineId'),

  /** When the pointer was rescued — i.e. when its `published_apps` row was destroyed. */
  recordedAt: timestamp('recordedAt', { mode: 'date', withTimezone: true }).defaultNow().notNull(),

  /** Kill attempts so far. A high count is a Fly app that cannot be killed — a real, billing anomaly worth alerting on. */
  attempts: integer('attempts').default(0).notNull(),

  /** When the last kill was attempted, and why it failed — the health signal for a stuck reclaim. */
  lastAttemptAt: timestamp('lastAttemptAt', { mode: 'date', withTimezone: true }),
  lastError: text('lastError'),
}, (table) => ({
  // The cron drains oldest-first, so it can be capped without starving a row.
  recordedAtIdx: index('app_hosting_reclaims_recorded_at_idx').on(table.recordedAt),
  attemptsNonNeg: check('app_hosting_reclaims_attempts_nonneg', sql`${table.attempts} >= 0`),
}));

export const publishedAppsRelations = relations(publishedApps, ({ one, many }) => ({
  page: one(pages, {
    fields: [publishedApps.pageId],
    references: [pages.id],
  }),
  drive: one(drives, {
    fields: [publishedApps.driveId],
    references: [drives.id],
  }),
  owner: one(users, {
    fields: [publishedApps.ownerId],
    references: [users.id],
  }),
  deployTokenMints: many(appDeployTokenMints),
}));

export const appDeployTokenMintsRelations = relations(appDeployTokenMints, ({ one }) => ({
  publishedApp: one(publishedApps, {
    fields: [appDeployTokenMints.publishedAppId],
    references: [publishedApps.id],
  }),
}));

export type PublishedApp = typeof publishedApps.$inferSelect;
export type NewPublishedApp = typeof publishedApps.$inferInsert;
export type AppDeployTokenMint = typeof appDeployTokenMints.$inferSelect;
export type NewAppDeployTokenMint = typeof appDeployTokenMints.$inferInsert;
export type AppHostingReclaim = typeof appHostingReclaims.$inferSelect;
export type NewAppHostingReclaim = typeof appHostingReclaims.$inferInsert;
