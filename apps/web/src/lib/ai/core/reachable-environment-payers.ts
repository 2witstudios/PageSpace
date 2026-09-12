/**
 * "Can this person run ANYWHERE they can reach?" — asked once, in one place.
 *
 * Two surfaces need this question and they must not drift: the DISCOVERY gate
 * (`productionSandboxDiscoveryGate`, deciding whether `list_environments` may
 * answer) and the pipeline ELIGIBILITY strip
 * (`resolveSandboxToolEligibilityForConversation`, deciding whether the compute
 * family is registered for the request at all). Fixing one without the other
 * changes nothing — the strip removes the tool before the gate can allow it —
 * which is exactly why the iteration lives here rather than being written twice.
 *
 * They ask with DIFFERENT authorizers, and that is deliberate: the gate asks
 * the full call-time gate (kill switch, `canRunCode`, quota preflight) because
 * it stands where a call stands, while the strip asks `canRunCodeForSession`
 * because it stands where tool REGISTRATION stands. What must not differ is
 * *which payers get asked*, and that is what this owns.
 *
 * **By DRIVE, not by environment.** The payer is a property of the drive
 * (`resolveDriveEnvPayer` resolves the drive's owner, with no fallback), so
 * several machines in one drive are one question rather than several. A person
 * with ten machines across two drives costs two lookups, not ten. Collapsing
 * duplicates cannot change the answer — it is a disjunction over the same set —
 * only how many times it is asked.
 *
 * **Fail closed.** This function only ever WIDENS eligibility, so every
 * uncertainty resolves to `false`: the feature flag off, a drive whose payer
 * cannot be resolved (skipped, never treated as allowing), a listing that
 * throws. A drive that does not resolve must not refuse the others either —
 * one vanished drive is not an answer about a different one.
 */

import type { SubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';

/** What this needs from the world, injected so it is testable without a database. */
export interface ReachableEnvironmentPayerDeps {
  /** `LOCAL_ENVS_ENABLED` for this deployment. */
  isEnabled: () => Promise<boolean>;
  /** The environments this user may reach — already filtered for access AND visibility. */
  listEnvironments: (userId: string) => Promise<readonly { driveId: string }[]>;
  /** A drive's payer and their tier; `null` when the drive has vanished. */
  resolvePayer: (driveId: string) => Promise<{ payerId: string; tier: SubscriptionTier } | null>;
}

/** The production wiring, imported lazily so the chat pipeline loads neither store at module load. */
export const defaultReachableEnvironmentPayerDeps: ReachableEnvironmentPayerDeps = {
  isEnabled: async () => {
    const { isLocalEnvsEnabled } = await import('@pagespace/lib/services/drive-envs/local-envs-enabled');
    return isLocalEnvsEnabled();
  },
  listEnvironments: async (userId) => {
    const { listGlobalAssistantEnvironments } = await import('@/lib/drive-envs/drive-envs-runtime');
    return listGlobalAssistantEnvironments(userId);
  },
  resolvePayer: async (driveId) => {
    const { resolveDriveEnvPayer } = await import('@/lib/drive-envs/drive-envs-runtime');
    return resolveDriveEnvPayer(driveId);
  },
};

/**
 * Does ANY drive behind this user's reachable environments authorize them?
 *
 * @param authorize asked once per DISTINCT drive, with that drive's payer.
 * @returns `true` on the first drive that allows; `false` if none do, or on any
 *          uncertainty at all.
 */
export async function anyReachableEnvironmentPayerAllows(input: {
  userId: string;
  authorize: (payer: { payerId: string; tier: SubscriptionTier }) => Promise<boolean>;
  deps?: ReachableEnvironmentPayerDeps;
}): Promise<boolean> {
  const deps = input.deps ?? defaultReachableEnvironmentPayerDeps;
  try {
    if (!(await deps.isEnabled())) return false;
    const environments = await deps.listEnvironments(input.userId);
    for (const driveId of new Set(environments.map((env) => env.driveId))) {
      const payer = await deps.resolvePayer(driveId);
      // A vanished drive is skipped, never an answer about the others.
      if (!payer) continue;
      if (await input.authorize(payer)) return true;
    }
    return false;
  } catch {
    return false;
  }
}
