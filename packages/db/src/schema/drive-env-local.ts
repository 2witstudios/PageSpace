import { pgTable, text, timestamp, jsonb, check, unique } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { driveEnvs, DRIVE_ENV_SUBSTRATES } from './drive-envs';

export { DRIVE_ENV_SUBSTRATES };

/**
 * Local Environment connection facts — the 1:1 sibling of a `drive_envs` row
 * whose `substrate = 'local'` (Local Environments epic, M1 · t05).
 *
 * A local env is the user's OWN machine, reached through the zero-trust bridge
 * (`packages/lib/src/env-bridge/`). Everything Sprite-shaped stays on
 * `drive_envs` and stays NULL for a local row (CHECK-enforced there); the facts
 * that only a bridged machine has live here, so they never clutter the Sprite
 * row or the crons' table scans:
 *
 * - **Identity is MACHINE-HELD.** The daemon generates an Ed25519 keypair at
 *   enrollment; the private key never leaves the machine's keychain. This row
 *   stores only the PUBLIC key, its fingerprint (pinned on every handshake),
 *   and which server signing key the machine pinned in return. There is
 *   deliberately no credential, token or secret column: a leaked row must be
 *   worth nothing (epic invariant 2).
 * - **`serverPolicy` is deny-by-default.** The drive's allow-set for this env
 *   (`{ ops, checkpoint }`), intersected on the server with what the machine
 *   advertised and — independently — re-checked by the machine's own policy;
 *   the server is necessary, never sufficient (invariant 4).
 * - **`bindPolicy` defaults to `'owner'`.** Who may bind a session to this env:
 *   only the enrolling user, or drive admins too, or any member who passes the
 *   code-execution gate. RCE on personal hardware warrants the strictest
 *   default (invariant 11); the pure gate is `decideBind` in `env-bridge`.
 * - **No stored connection status.** `connected|connecting|disconnected` is
 *   derived from `lastSeenAt` plus the live socket registry, the way an env's
 *   Sprite status is derived from its pointers — a cached status is a lie
 *   waiting for a crash.
 *
 * `envId` is both the primary key and a cascading FK: deleting the env deletes
 * its connection facts. The relation edge lives on THIS side only —
 * `drive-envs.ts` must not import this module (it already imports the other
 * way for the FK; see its docblock on the sessions edge for the same rule).
 */
export const DRIVE_ENV_BIND_POLICIES = ['owner', 'admins', 'members'] as const;
export type DriveEnvBindPolicy = (typeof DRIVE_ENV_BIND_POLICIES)[number];

/** What the machine advertised in its last `hello`. Mirrors `AdvertisedCapabilities` in `env-bridge`. */
export interface DriveEnvLocalCapabilities {
  shell: boolean;
  pty: boolean;
  fs: boolean;
  checkpoint: boolean;
}

/** The drive's allow-set for this env. Mirrors `AllowedOperations` in `env-bridge`. */
export interface DriveEnvLocalServerPolicy {
  ops: string[];
  checkpoint: boolean;
}

export const driveEnvLocal = pgTable('drive_env_local', {
  /** PK and cascading FK to the env this row describes. */
  envId: text('envId')
    .primaryKey()
    .references(() => driveEnvs.id, { onDelete: 'cascade' }),

  /** Human name of the machine ("jono-macstudio"). A label, never an address. */
  label: text('label').notNull(),

  /** Durable enrollment identity — the wire id the daemon presents. Unique across all envs. */
  enrollmentId: text('enrollmentId').notNull(),

  /** The machine's Ed25519 PUBLIC key (SPKI, base64). The private half never leaves the machine. */
  machinePublicKey: text('machinePublicKey').notNull(),

  /** Fingerprint of `machinePublicKey`, pinned and re-checked on every handshake. */
  machineKeyFingerprint: text('machineKeyFingerprint').notNull(),

  /** Which server signing key the machine pinned at enrollment (for rotation). */
  serverKeyId: text('serverKeyId').notNull(),

  /** Last advertised capabilities (from `hello`). NULL until the first handshake. */
  capabilities: jsonb('capabilities').$type<DriveEnvLocalCapabilities>(),

  /** The drive's allow-set for this env. Deny-by-default. */
  serverPolicy: jsonb('serverPolicy')
    .$type<DriveEnvLocalServerPolicy>()
    .notNull()
    .default({ ops: [], checkpoint: false }),

  /** Who may bind a session to this env. See the table docblock. */
  bindPolicy: text('bindPolicy').notNull().default('owner'),

  /** Last heartbeat / handshake. Drives the derived connection status. NULL = never connected. */
  lastSeenAt: timestamp('lastSeenAt', { mode: 'date' }),
  /** When enrollment completed (public key pinned). NULL = code issued, not yet enrolled. */
  enrolledAt: timestamp('enrolledAt', { mode: 'date' }),
  /** When the machine's enrollment was revoked. NULL = live. A revoked env refuses every bind and token mint. */
  revokedAt: timestamp('revokedAt', { mode: 'date' }),

  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => ({
  /** The wire identity must name exactly one env. */
  enrollmentIdUnique: unique('drive_env_local_enrollment_id_unique').on(table.enrollmentId),

  /** The closed bind-policy set, enforced at the row. */
  bindPolicyCheck: check('drive_env_local_bind_policy_check', sql`${table.bindPolicy} IN ('owner', 'admins', 'members')`),
}));

export const driveEnvLocalRelations = relations(driveEnvLocal, ({ one }) => ({
  env: one(driveEnvs, {
    fields: [driveEnvLocal.envId],
    references: [driveEnvs.id],
  }),
}));

export type DriveEnvLocal = typeof driveEnvLocal.$inferSelect;
export type NewDriveEnvLocal = typeof driveEnvLocal.$inferInsert;
