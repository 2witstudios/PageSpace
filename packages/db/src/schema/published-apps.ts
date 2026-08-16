import { pgTable, text, integer, bigint, timestamp, index, pgEnum, check } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';
import { drives } from './core';
import { driveEnvs } from './drive-envs';

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
 * publishedApps — the Fly SERVING RECORD of a published environment: one row per
 * published env, one Fly app each.
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

  /**
   * The ENVIRONMENT this app serves — the publish target, and the only thing this
   * row hangs off. One published app per env, enforced here.
   *
   * Publishing is something you do TO an environment: the Fly serving tier is
   * built FROM an env's contents at publish time. It is deliberately NOT an env
   * itself and has no session surface, which is why the pointer runs this way
   * (hosting row → env) and never the reverse: `drive_envs` carries Sprite
   * pointers only, and nothing on it may ever name a Fly app. That partition is
   * what keeps the two teardown outboxes separate — Sprite pointers are rescued
   * into `machine_sprite_reclaims`, Fly app names into `app_hosting_reclaims`.
   *
   * WHAT gets published is not recorded here. Promotion (which commit, which
   * build) is a later concern and lands as its own additive column when it
   * exists; a source pointer invented now would be a second, unsynchronised
   * answer to a question the env already answers.
   *
   * Cascading: deleting the env destroys its hosting row, and the AFTER DELETE
   * trigger below rescues `flyAppName` on the way out — an env delete can
   * therefore never strand a billing Fly app. The reverse is NOT true and must
   * not become true: unpublishing deletes this row and leaves the env alone.
   */
  envId: text('envId').notNull().unique().references(() => driveEnvs.id, { onDelete: 'cascade' }),

  /**
   * Denormalized from the env so the claim and metering queries don't join
   * through `drive_envs` on every tick. Cascades independently: a permanent
   * drive delete must reach this row even if the env rows go first. The service
   * layer validates that `envId`'s env really belongs to this drive — the
   * database cannot express that cross-row agreement, so the write path owns it.
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

  /**
   * The registry size of `imageDigest`, in bytes (config blob + every layer, as
   * the manifest reports them). NULL until a build records one.
   *
   * THIS IS THE IDLE-COST LEVER, which is why it is a persisted column rather
   * than something the economics dashboard derives on demand. A published app
   * that is stopped costs nothing per second and still costs rootfs storage at
   * $0.15/GB-month — for the fleet, that fixed drip is the whole per-app floor,
   * and it is set by whatever the build pushed. Recording it at build time is
   * also the only moment the number is knowable cheaply: reading it later means
   * a registry round-trip per app, and reading it after the image is replaced
   * means it is gone.
   *
   * Written in the SAME statement as `imageDigest`, because a size attributed to
   * the wrong digest is worse than no size at all.
   */
  imageSizeBytes: bigint('imageSizeBytes', { mode: 'number' }),

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

  /**
   * When a worker last took this row to work on it — the claim LEASE.
   *
   * `FOR UPDATE SKIP LOCKED` alone does NOT claim anything. Those locks live and
   * die with their transaction, so a claim query that only selects hands the same
   * rows to the next worker the instant it commits — which is before the caller has
   * done any work. The claim has to be a WRITE inside the locking transaction, and
   * this column is that write.
   *
   * A lease rather than a permanent flag because a worker that crashes mid-provision
   * would otherwise strand its rows forever, and nothing would ever finish them.
   * Past the lease horizon the row is claimable again — see
   * `PUBLISHED_APP_CLAIM_LEASE_MS`.
   */
  claimedAt: timestamp('claimedAt', { mode: 'date', withTimezone: true }),

  /**
   * WHICH claim holds this row — a fresh opaque token per successful claim.
   *
   * `claimedAt` says a lease exists; this says whose it is. A worker whose work
   * outlived its lease must not be able to release (or report on) a row the next
   * worker legitimately took over, so every write that ends a claim carries this
   * token as a predicate.
   *
   * Deliberately not `claimedAt` itself: Postgres keeps microseconds and a JS Date
   * holds milliseconds, so a stamp read back through the driver never equals the
   * stored value and the fence would silently match nothing — failing OPEN in the
   * one place that must fail closed. (The same reasoning as
   * `broadcast_recipients.claimed_by`, which this copies.)
   */
  claimedBy: text('claimedBy'),

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
  // A negative image size is not a small number, it is a corrupt one — and it
  // would land in the economics dashboard's SUM as a silent credit against every
  // other app's storage cost.
  imageSizeNonNeg: check(
    'published_apps_image_size_nonneg',
    sql`${table.imageSizeBytes} IS NULL OR ${table.imageSizeBytes} >= 0`,
  ),
  subdomainNonEmpty: check(
    'published_apps_subdomain_nonempty',
    sql`length(${table.subdomain}) > 0`,
  ),
  // A lease with no holder cannot be fenced, and a holder with no lease never
  // expires — either half alone is a claim that fails open. Written as a
  // biconditional rather than a one-way implication, which would constrain only
  // one of the two bad states.
  claimCoherent: check(
    'published_apps_claim_coherent',
    sql`(${table.claimedAt} IS NULL) = (${table.claimedBy} IS NULL)`,
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

  /**
   * When the mint was ATTEMPTED — this row is inserted BEFORE the Fly call, not
   * after it. See `outcome`: until that settles, this is the instant a credential
   * may have come into existence, not proof that one did.
   */
  mintedAt: timestamp('mintedAt', { mode: 'date', withTimezone: true }).defaultNow().notNull(),

  /**
   * The two-phase record: 'pending' → 'minted' | 'failed'.
   *
   * Writing the row after a successful mint loses the credential entirely if the
   * process dies in between — and what is lost is the ONLY evidence a
   * self-renewing, app-scoped token exists. So the intent is recorded first and
   * settled second, which inverts the loss: the failure mode becomes a row
   * describing a token that was never issued, which is noise, rather than a token
   * nobody can account for, which is a security incident.
   *
   * A row still 'pending' well past its request is therefore a RECONCILIATION
   * ITEM, not a bug: a mint may or may not have happened. The only safe resolution
   * is at the app level — Fly hands back no token id, so a suspect app is
   * remediated by destroying it (which revokes every token scoped to it), never by
   * assuming the mint failed.
   *
   * NO BACKFILL accompanies the migration that added this column, and none is
   * possible: the migration that CREATES this table (0264) is in the same
   * unreleased release, so no database has ever held a row here. `runMigrations`
   * applies every pending entry in one invocation, which means 0264 and 0266 land
   * together on every deployment, empty table first. Were legacy rows possible they
   * would have to be stamped `outcome = 'minted', settledAt = "mintedAt"`, since
   * the pre-two-phase code only ever inserted after a successful mint.
   */
  outcome: text('outcome').default('pending').notNull(),

  /** When `outcome` stopped being 'pending'. NULL exactly while it is. */
  settledAt: timestamp('settledAt', { mode: 'date', withTimezone: true }),

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
  outcomeAllowed: check(
    'app_deploy_token_mints_outcome_allowed',
    sql`${table.outcome} IN ('pending', 'minted', 'failed')`,
  ),
  // Biconditional: a settled row must say when, and a pending one must not claim
  // it already settled. The reconciler reads exactly this pair.
  settledCoherent: check(
    'app_deploy_token_mints_settled_coherent',
    sql`(${table.outcome} = 'pending') = (${table.settledAt} IS NULL)`,
  ),
}));

/**
 * appHostingReclaims — the teardown OUTBOX for published Fly apps.
 *
 * A published Fly app is a real, billing resource. The only way to find one is its
 * `flyAppName`, and that name lives on `published_apps` — which FK-cascades off
 * `drive_envs.id` AND `drives.id` (and through them off `users.id`). So every path
 * that hard-deletes an environment or a drive destroys the only pointer to an app
 * that may still be serving and billing: deleting an env, a permanent drive delete,
 * the 30-day GDPR purge, the account-erasure worker, and any path someone adds
 * tomorrow. This is not hypothetical — the Sprites equivalent of exactly this
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
 * matter which table's delete started it — an env delete, a drive delete, a user
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
  env: one(driveEnvs, {
    fields: [publishedApps.envId],
    references: [driveEnvs.id],
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
