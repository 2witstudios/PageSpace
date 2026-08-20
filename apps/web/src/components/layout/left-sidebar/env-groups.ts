/**
 * Splits one drive group's sessions into its ENVIRONMENTS and its loose
 * sessions — pure and side-effect free, the environment-level counterpart to
 * `session-groups.ts`.
 *
 * The mental model this encodes: a drive contains environments AND sessions at
 * the same level, and an environment contains sessions. A session's `envId`
 * says which filesystem it is a window onto (see the field's docblock on
 * `session-contract.ts`), so grouping by it is grouping by shared disk — not by
 * a label someone attached.
 *
 * Two rules are borrowed from `session-groups.ts` deliberately, because they
 * are the same two problems one level down:
 *
 *  - **The listing is the roster.** Every environment the drive returns gets a
 *    group even with zero sessions. An environment is infrastructure the user
 *    deliberately created and pays for; it does not disappear when nothing is
 *    running in it, and a surface that hid empty ones would make "my
 *    environment is gone" the normal reading of an idle afternoon.
 *  - **A session is never dropped.** A session naming an environment the
 *    listing omits (a member whose env read failed, a row deleted between the
 *    two fetches) becomes an ORPHAN group rather than vanishing, with a null
 *    name the render layer falls back from.
 */

import type { DriveEnvDTO, DriveEnvStatus } from '@pagespace/lib/drive-envs/env-contract';

export interface EnvGroup<T> {
  envId: string;
  /** Null for an orphan — an env a session names but the drive's listing did not return. */
  envName: string | null;
  /** Null for an orphan, for the same reason: there is no row here to derive one from. */
  status: DriveEnvStatus | null;
  sessions: T[];
}

export interface EnvPartition<T> {
  envGroups: EnvGroup<T>[];
  /** The drive's ordinary ephemeral sessions — each owns its own sandbox. */
  looseSessions: T[];
}

function byEnvDisplayName<T>(a: EnvGroup<T>, b: EnvGroup<T>): number {
  const nameA = a.envName ?? a.envId;
  const nameB = b.envName ?? b.envId;
  return nameA.localeCompare(nameB) || a.envId.localeCompare(b.envId);
}

export function partitionSessionsByEnv<T extends { envId: string | null }>(
  sessions: readonly T[],
  envs: readonly DriveEnvDTO[],
): EnvPartition<T> {
  const sessionsByEnv = new Map<string, T[]>();
  const looseSessions: T[] = [];
  for (const session of sessions) {
    // Truthiness rather than `!== null`: an older client bundle (or a listing
    // served mid-deploy) can hand back a session with the field simply absent,
    // and "I do not know" has to read as the ephemeral default — never as a
    // group keyed on `undefined`, which would collect every such session into
    // one phantom environment.
    if (!session.envId) {
      looseSessions.push(session);
      continue;
    }
    sessionsByEnv.set(session.envId, [...(sessionsByEnv.get(session.envId) ?? []), session]);
  }

  const listedIds = new Set(envs.map((env) => env.id));

  const listedGroups = envs
    .map((env) => ({
      envId: env.id,
      envName: env.name,
      status: env.status,
      sessions: sessionsByEnv.get(env.id) ?? [],
    }))
    .sort(byEnvDisplayName);

  const orphanGroups = [...sessionsByEnv.keys()]
    .filter((envId) => !listedIds.has(envId))
    .map((envId) => ({
      envId,
      envName: null,
      status: null,
      sessions: sessionsByEnv.get(envId) ?? [],
    }))
    .sort(byEnvDisplayName);

  return { envGroups: [...listedGroups, ...orphanGroups], looseSessions };
}
