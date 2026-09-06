import { pgTable, text, integer, timestamp, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { agentWorkspaces } from './agent-workspaces';
import { driveEnvs } from './drive-envs';

/**
 * Dev-preview services — the durable state of "a dev server in this sandbox
 * is being offered as a live preview".
 *
 * A user runs `vite` / `next dev` inside a sandbox Sprite — an ephemeral
 * session Sprite (`agent_workspaces`) or a persistent environment Sprite
 * (`drive_envs`) — and PageSpace's same-origin authenticated proxy shows the
 * running app in the browser. This row records WHICH port the preview targets,
 * HOW the sprite URL reaches it, and whether the user has switched it off.
 *
 * **Why an in-sprite relay exists at all (live-verified, twice).** The sprite
 * URL proxies to **port 8080 inside the VM, always**: a service's `httpPort`
 * is stored and does nothing, there is no one-http-port 409, and no
 * start-on-request (docs/spikes/2026-08-dev-preview-sprite-services-spike.md
 * §3, re-proven with raw `fetch()` and five-minute polling windows in §8).
 * So a dev server on 5173 is unreachable until something on 8080 forwards to
 * it. That something is the RELAY: a tiny runtime-managed service (started
 * through the `SandboxHandle.services` seam) bound to 8080 and piping bytes to
 * `targetPort`. One sprite has one 8080, so one sprite has at most one relay,
 * so one Sprite INSTANCE has at most one row here — that is the UNIQUE index
 * on `spriteInstanceId`, and it is the old design doc's "one http-port slot"
 * with 8080 substituted for the slot. The fallback when 8080 is already taken
 * by something that is not our relay is honest copy ("run your server on
 * 8080"), never a second relay.
 *
 * **Keyed to the Sprite INSTANCE, fail closed** (the `egress-lockdown.ts`
 * pattern: "a proof we cannot construct is a proof we do not have"). A Sprite
 * NAME is reused across re-creates; the instance id is the VM's actual
 * identity. A preview row names the instance whose relay it describes, and a
 * reader that finds its holder's live `spriteInstanceId` differs from the
 * row's must treat the row as STALE: the relay it describes ran on a VM that
 * no longer exists, and the replacement inherits NOTHING — not the target
 * port, not the running state, not even the stopped-by-user intent. Reviving
 * a preview on the new instance is an explicit re-create driven by a fresh
 * port detection on that instance (`planDevServerService` in
 * `@pagespace/lib/services/sandbox/preview/dev-preview-core`), never a
 * silent carry-over. This is what makes an env's preview re-assertable after
 * a rebuild without ever being assumed after one.
 *
 * **Holder-polymorphic, the sprite-holder way.** Exactly one of
 * `workspaceId` (a session) or `envId` (an env) is set — CHECK-enforced — and
 * each is a cascading FK, so the row cannot outlive the holder that owns the
 * sprite. **The holder is whoever OWNS the sprite pointer.** An env-bound
 * session carries `envId` and NO sprite columns
 * (`agent_workspaces_env_no_sprite_check`): it borrows the ENV's VM, so a
 * dev server detected inside it belongs to the ENV row, never to the
 * session — two sessions in one env converge on ONE row, and it lives and
 * dies with the env, which is the lifecycle that actually owns the VM
 * (`resolveDevPreviewHolder` in the decision core states the rule in code).
 *
 * **One row per holder, structurally.** The partial unique indexes on
 * `workspaceId` and `envId` are what make "re-create replaces" TRUE rather
 * than aspirational: a rebuild mints a new instance id, so the instance
 * index alone never collides and a plain INSERT would leave one dead row
 * per rebuild. With the holder unique, the effects layer's write is an
 * UPSERT with the holder as its conflict target, and a holder's dead-instance
 * row is REPLACED by the re-create, never accumulated beside it. A
 * `substrate = 'local'` env is structurally outside this table: it holds no
 * sprite pointer, so there is no `spriteInstanceId` (NOT NULL) to key a row
 * on. A session's preview dies with the session BY CONSTRUCTION: ending a
 * session tears down its Sprite (`plan-workspace-lifecycle.ts`), which kills
 * the relay process with the VM, and the row — now naming a dead instance —
 * is stale to every reader until the session row itself is deleted and
 * cascades it away. An env's preview survives a REBUILD only as a stale row,
 * for the same reason: `rebuildDriveEnv` (services/drive-envs/drive-envs.ts)
 * is teardown ⇒ re-provision, which mints a new instance id.
 *
 * **Teardown story: rows die with the sprite instance, and there is NO
 * reclaim outbox — deliberately.** `machine_sprite_reclaims` exists because a
 * Sprite is a real, billing microVM whose only pointer can be cascaded away.
 * A relay is not that. It is a process INSIDE the sprite: when the sprite is
 * destroyed the relay goes with it (`deleteSprite` succeeds with services
 * defined and needs no separate service teardown — spike §4), it holds no
 * external resource, and it bills nothing on its own — a sprite with a
 * RUNNING service still hibernates on idle (spike §6, verified: `running` →
 * `warm` within ~60–80s), so a forgotten relay does not keep a VM awake. The
 * one thing that DOES wake a sprite is an inbound URL request (spike §6), and
 * that is the proxy's wake gate to enforce, not a state this table can leak.
 * A stale row therefore describes nothing that costs money or needs killing;
 * it is inert until its holder cascades it or a re-create replaces it (the
 * holder-unique upsert above — the replacement is a database fact, not a
 * cleanup someone has to run).
 *
 * **Every teardown path that kills a sprite already covers this table.** A
 * session end / env rebuild / env delete kills the VM (relay included) and
 * either stamps the holder's `spriteTornDownAt` (row goes stale by instance
 * mismatch) or deletes the holder (row cascades). The orphan reconciler and
 * the reclaim outbox kill by name+instance and never need to know about
 * relays. Nothing here asks to be added to any of those paths.
 *
 * **There is NO public-exposure column, and that is a decision.** v1 preview
 * is org-token-only behind PageSpace's own proxy (the sprite URL stays
 * `auth: 'sprite'`); sandboxes run open egress, so an inbound-reachable
 * open-egress machine is a relay shape that needs its own containment ruling
 * before it can exist. Adding exposure later is a MIGRATION, on purpose:
 * nobody gets to flip a bit that was never designed.
 *
 * **Migration seam.** If the platform ever ships the documented `httpPort`
 * routing (a service's declared port becoming the URL's target, with the 409
 * and start-on-request the docs describe), the relay becomes unnecessary: the
 * user's own dev server gets created as the service with `httpPort`, and
 * `relayServiceName` goes NULL for every row while `targetPort` keeps meaning
 * exactly what it means today. The CHECK below would then be relaxed (a
 * non-8080 target with no relay becomes legal), and nothing else here moves.
 *
 * **No stored status.** Whether the relay is running is a live read of the
 * services API (`describeServiceState` folds the row with it); a cached
 * reading of a process is a lie waiting for a crash. What IS stored is
 * INTENT that the platform cannot report: `stoppedByUserAt`, because a
 * stopped service records `failed` ("exited with code 143"), which is
 * indistinguishable from a crash without it (spike §4).
 */
export const DEV_PREVIEW_SPRITE_HTTP_PORT = 8080;

export const devPreviewServices = pgTable(
  'dev_preview_services',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),

    // -------------------------------------------------------------------------
    // The HOLDER — exactly one of the two, CHECK-enforced below. Both cascade:
    // the row is a fact about the holder's sprite and cannot outlive the holder.
    // -------------------------------------------------------------------------

    /** The SESSION whose sprite this preview lives in. NULL for an env preview. */
    workspaceId: text('workspaceId').references(() => agentWorkspaces.id, { onDelete: 'cascade' }),

    /** The ENV whose sprite this preview lives in. NULL for a session preview. */
    envId: text('envId').references(() => driveEnvs.id, { onDelete: 'cascade' }),

    // -------------------------------------------------------------------------
    // The Sprite INSTANCE — the identity every reader must check first.
    // -------------------------------------------------------------------------

    /**
     * The platform's id for the Sprite INSTANCE the relay was planned on. NOT
     * NULL: a row that cannot name its instance cannot be proven to describe
     * the VM a reader is looking at, and an unprovable claim is never recorded
     * (the planner refuses when the live instance id is unknown). UNIQUE:
     * one 8080 per VM, one relay per 8080, one row per instance.
     */
    spriteInstanceId: text('spriteInstanceId').notNull(),

    /**
     * The Sprite's NAME at planning time, denormalized from the holder so the
     * effects layer can address the services API without a join. Identity is
     * `spriteInstanceId`, never this — a name is reused across re-creates.
     */
    sandboxId: text('sandboxId').notNull(),

    // -------------------------------------------------------------------------
    // What the preview points at, and how 8080 reaches it.
    // -------------------------------------------------------------------------

    /**
     * The port the user's dev server was detected on (a `port_opened`
     * notification — spike §5/§9). 1–65535. When it is 8080 the server is
     * reachable through the URL directly and there is no relay.
     */
    targetPort: integer('targetPort').notNull(),

    /**
     * The runtime service NAME of the relay bound to 8080 and forwarding to
     * `targetPort` — what `services.get/stop/remove` are called with. NULL iff
     * `targetPort` is 8080 (CHECK below): a relay from 8080 to 8080 is a loop,
     * and a non-8080 target with no relay is unreachable, so neither state is
     * a row. Always `pagespace-preview-relay` today; a column rather than a
     * constant so a row can outlive a rename of the constant.
     */
    relayServiceName: text('relayServiceName'),

    /** When the `port_opened` that this row answers was observed. */
    detectedAt: timestamp('detectedAt', { mode: 'date' }).notNull(),

    /**
     * Durable STOPPED-BY-USER intent. The platform cannot report it: an
     * explicit stop lands the service in `failed`, the same state as a crash
     * (spike §4). NULL = the user has not switched this preview off. Set =
     * the planner will not start or replace the relay on this instance until
     * an explicit user action clears it — a new detection does not.
     */
    stoppedByUserAt: timestamp('stoppedByUserAt', { mode: 'date' }),

    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
  },
  (table) => ({
    /** One relay per VM: the 8080 slot, as a row. */
    spriteInstanceUnique: uniqueIndex('dev_preview_services_sprite_instance_idx').on(table.spriteInstanceId),

    /**
     * One row per HOLDER — the upsert's conflict targets (see the table
     * docblock). Partial, so the NULL side of each row stays out of the index
     * and the two never interfere. These double as the holder lookups.
     */
    workspaceUnique: uniqueIndex('dev_preview_services_workspace_id_idx')
      .on(table.workspaceId)
      .where(sql`${table.workspaceId} IS NOT NULL`),
    envUnique: uniqueIndex('dev_preview_services_env_id_idx')
      .on(table.envId)
      .where(sql`${table.envId} IS NOT NULL`),

    /** Exactly one holder. `(a IS NULL) <> (b IS NULL)` is true only when one side is NULL. */
    oneHolderCheck: check(
      'dev_preview_services_one_holder_check',
      sql`(${table.workspaceId} IS NULL) <> (${table.envId} IS NULL)`,
    ),

    /** A TCP port. */
    targetPortRangeCheck: check(
      'dev_preview_services_target_port_range_check',
      sql`${table.targetPort} BETWEEN 1 AND 65535`,
    ),

    /**
     * A relay exists iff the target is not 8080. See `relayServiceName`; this
     * is the CHECK the migration seam in the table docblock would relax.
     */
    relayIffNot8080Check: check(
      'dev_preview_services_relay_iff_not_8080_check',
      sql`(${table.targetPort} = ${sql.raw(String(DEV_PREVIEW_SPRITE_HTTP_PORT))}) = (${table.relayServiceName} IS NULL)`,
    ),
  }),
);

export const devPreviewServicesRelations = relations(devPreviewServices, ({ one }) => ({
  workspace: one(agentWorkspaces, {
    fields: [devPreviewServices.workspaceId],
    references: [agentWorkspaces.id],
  }),
  env: one(driveEnvs, {
    fields: [devPreviewServices.envId],
    references: [driveEnvs.id],
  }),
}));

export type DevPreviewService = typeof devPreviewServices.$inferSelect;
export type NewDevPreviewService = typeof devPreviewServices.$inferInsert;
