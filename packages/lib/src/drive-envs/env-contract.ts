/**
 * The drive-environment wire contract — the DTO every client is served, and the
 * one validator each side parses with.
 *
 * The rule `session-contract.ts` established governs this module too: a shape
 * that crosses a process boundary is declared ONCE, here, and never restated at
 * a route. `Date` never crosses the boundary (ISO-8601 strings only).
 *
 * **The name is part of the contract, not a label.** `(driveId, name)` is UNIQUE
 * on `drive_envs` — the deliberate exception to the repo's "ids address, names
 * label" rule, because an environment is a target humans and pipelines name out
 * loud ("promote to staging"). So the name is validated HERE, at the boundary,
 * rather than left to the database's unique index to reject after the fact: a
 * blank or whitespace-only name is a 400, not a row.
 *
 * There is deliberately NO `kind` field. Environments are untyped and uniformly
 * Sprite-backed; dev / staging / prod are use cases expressed by NAMING an env
 * (see the `drive_envs` table docblock, which explains why the enum was deleted
 * rather than never written).
 */

import { z } from 'zod';

/** Longest environment name accepted. Long enough for `staging-eu-west` and its kin, short enough to render in a sidebar row. */
export const MAX_DRIVE_ENV_NAME_LENGTH = 64;

/**
 * The most environments one listing returns — and, because the store's list
 * query carries it as a LIMIT, the most a drive's listing can ever show.
 *
 * It is also the CEILING ON THE CEILING: `quota.ts` clamps every per-tier
 * `DRIVE_ENV_LIMIT_*` to this number, so no payer can hold more environments
 * than a listing can display. That coupling is deliberate and load-bearing. An
 * env row that exists but never appears is a machine the drive is paying for
 * with no surface that admits it exists — strictly worse than a refused create
 * — and a
 * per-payer ceiling above a per-drive listing cap is exactly how you get one,
 * since nothing stops a payer concentrating their envs in a single drive. (The
 * cost is real from creation even though the app's storage meter does not read
 * `drive_envs` yet — see `checkDriveEnvAllowance`.)
 *
 * Raising this is therefore the FIRST half of raising any tier ceiling past
 * 100; paginating the listing is the alternative, and would let the two numbers
 * come apart safely.
 */
export const MAX_DRIVE_ENVS_LISTED = 100;

/**
 * An environment name as accepted from a client: trimmed, non-empty, bounded.
 *
 * Trimming is part of the schema rather than a call-site habit because the
 * uniqueness that makes a name an ADDRESS is the database's, and `staging` vs
 * `staging ` would otherwise be two distinct rows a user cannot tell apart.
 */
export const driveEnvNameSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1).max(MAX_DRIVE_ENV_NAME_LENGTH));

/**
 * The Sprite states an environment can be reported in, DERIVED from its pointer
 * columns and never stored (`deriveDriveEnvStatus`).
 *
 * Three, not the session surface's four:
 *
 *  - `'none'` — never provisioned. The state a freshly-created env sits in until
 *    the first session runs inside it (envs provision lazily).
 *  - `'running'` — a Sprite is linked. INCLUDING a hibernating one: idle Sprites
 *    hibernate and wake on demand, which is invisible to the user.
 *  - `'stopped'` — the Sprite was torn down (a rebuild in flight, or a reclaim),
 *    and the ENV ROW SURVIVES. This is where the session vocabulary stops
 *    fitting: a session's equivalent state is `'ended'`, a terminal fact about
 *    the session itself, whereas an env outliving its machine is the entire
 *    point of an env. Reusing the word would tell a client the environment was
 *    over when it is merely idle between machines.
 *
 * `'starting'` is deliberately absent for the same reason it is absent from
 * `SandboxStatus`: provisioning happens inside ONE call, so there is no
 * persisted in-flight state to read.
 */
export const DRIVE_ENV_STATUSES = ['none', 'running', 'stopped'] as const;

export const driveEnvStatusSchema = z.enum(DRIVE_ENV_STATUSES);
export type DriveEnvStatus = z.infer<typeof driveEnvStatusSchema>;

/** Wire timestamps are ISO-8601 strings; `Date` never crosses the boundary. */
const isoTimestamp = z.string().datetime();

/**
 * One drive environment as served to any client.
 *
 * Deliberately NARROW: identity, ownership, name, derived status, birthday. No
 * Sprite pointer, no egress token, no storage measurement — those are internal
 * lifecycle and billing facts, and a client that could read `sandboxId` would be
 * one step from addressing a VM by something other than its env.
 */
export const driveEnvDtoSchema = z.object({
  /** `drive_envs.id` — the API address and the Sprite-key fold. */
  id: z.string().min(1),
  /** The owning drive. An env has no user-scoped form: it is drive-owned, drive-paid, drive-shared. */
  driveId: z.string().min(1),
  /** Unique within the drive — an address humans use, not a label. */
  name: z.string().min(1),
  status: driveEnvStatusSchema,
  createdAt: isoTimestamp,
});

export type DriveEnvDTO = z.infer<typeof driveEnvDtoSchema>;

/** POST body for creating an environment. Just a name — there is no kind to choose. */
export const createDriveEnvRequestSchema = z.object({
  name: driveEnvNameSchema,
});

/** PATCH body for renaming an environment. */
export const renameDriveEnvRequestSchema = z.object({
  name: driveEnvNameSchema,
});
