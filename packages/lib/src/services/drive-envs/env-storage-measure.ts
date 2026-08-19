/**
 * The env's opportunistic storage-measurement seam — the WRITE side of the
 * meter that bills an environment.
 *
 * **Why this is its own module rather than a closure at the provisioner.** An
 * env is the billed PERSISTENCE unit, and the storage reconcile
 * (`services/sandbox/sandbox-storage-reconcile.ts`) only ever READS
 * `drive_envs.storageMeasuredBytes`. Wire no writer and every env prices at the
 * never-measured 0 floor forever while the cron keeps advancing its watermark —
 * the environment runs FREE, silently, with no error anywhere and no test that
 * notices. That is a billing hole whose only symptom is revenue that never
 * arrives, so the wiring must not be something a future refactor can drop
 * without a red test: this module and its suite are that red test, and they live
 * beside the store they write to rather than inside whichever provisioning
 * composition happens to hold the deps object this week.
 *
 * It is deliberately holder-shaped, not app-shaped: it returns exactly
 * `SpriteHolderProvisionDeps['measureStorage']`, typed FROM that seam, so any
 * composition that builds env provisioning deps — in an app today, in
 * `@pagespace/lib` tomorrow, in a second process after that — wires it in one
 * line and cannot get the shape wrong.
 *
 * What it does NOT own: the `du`, the throttle, and the parse all belong to
 * `refreshSessionStorageMeasurement` (`services/sandbox/sandbox-storage-measure.ts`),
 * shared verbatim with sessions. Measuring a filesystem is the same operation
 * whoever owns the disk; only WHICH ROW the bytes land on differs, and that row
 * is the whole content of this file.
 */

import { refreshSessionStorageMeasurement } from '../sandbox/sandbox-storage-measure';
import { loggers } from '../../logging/logger-config';
import type { SpriteHolderProvisionDeps } from '../agent-workspaces/agent-workspace-sprite';
import type { DriveEnvStore } from './drive-envs-store';

/**
 * The one store method this needs. A `Pick` of the real store rather than a
 * hand-written shape, so a change to the writer's contract breaks here instead
 * of sliding past — and so a composition can hand over its existing store
 * without a second adapter.
 */
export type EnvStorageMeasureStore = Pick<DriveEnvStore, 'recordStorageMeasurement'>;

/**
 * Build the `measureStorage` dep for an ENV's provisioning.
 *
 * Fired by `ensureSpriteHolderSandbox` on the `create` arm only, against a
 * Sprite that is already awake — never by waking a hibernating one, which would
 * recreate the keep-awake billing bug the reconcile exists to avoid. The core
 * calls it fire-and-forget, so a failure here can never fail a provision.
 *
 * **The baseline it captures is a FLOOR, not a truth, and today it is the ONLY
 * writer — so read this before assuming envs are fully metered.** A
 * freshly-minted env has an empty disk by definition, and an env accumulates its
 * real footprint across the sessions that run inside it. Those sessions do not
 * exist yet (env-bound sessions are the follow-up that gives an env its ensure
 * path); until they do, an env bills its provision-time baseline, which is
 * approximately nothing. That is deliberate and it is the honest end of this
 * slice: the write side exists, is proven, and is exported as ONE function the
 * warm path wires in one line — `envStorageMeasureSeam(store)` — reusing this
 * module's throttle and CAS rather than growing a second writer with its own
 * bugs.
 *
 * Two consequences worth naming, because both are silent:
 *
 *  - A single failed `du` here (an exec throw, a timeout, unparseable output),
 *    or a persist that rejects, leaves `storageMeasuredBytes` NULL with NOTHING
 *    TO RETRY IT, so that env bills the 0 floor indefinitely — and because the
 *    reconcile advances its watermark anyway (deliberately: freezing it would
 *    let a later measurement retroactively over-bill the frozen span), each
 *    skipped window is discarded for good rather than deferred. The direction of
 *    that error is always UNDER-billing, never over: both arms that fire this
 *    seam (`create` and `adopt`) null the measurement columns in the same write,
 *    via `reviveStamps`/`adopt`'s stamps through `envStampColumns`, so a failed
 *    measurement leaves a NULL row rather than the dead generation's footprint.
 *    Every one of those paths LOGS with the env's id, and the reconcile counts
 *    the aggregate as `neverMeasured`, so the failure is observable both per-env
 *    and in the meter's own health output — but observability is not repair.
 *    Retrying belongs on the warm path, which is the env ensure path's to own:
 *    tracked in issue #2443.
 *  - A measurement is never REDUCED by this path; it only ever writes what it
 *    read. Shrink correction likewise waits on the warm path.
 */
export function envStorageMeasureSeam(
  store: EnvStorageMeasureStore,
): NonNullable<SpriteHolderProvisionDeps['measureStorage']> {
  return async ({ holderId, handle }) => {
    // Every failure below is LOGGED here, and that is load-bearing rather than
    // tidy. The provisioner swallows this seam's rejection with a `.catch()`
    // whose comment reads "the seam already logs" — so a seam that stays silent
    // makes that comment false and the failure invisible. And silence costs more
    // for an env than for a session: a session has other measurement writers
    // that self-correct on its next real work, while this is an env's ONLY
    // writer, so a lost measurement here means that env bills the 0 floor
    // indefinitely. The reconcile's `neverMeasured` shows the aggregate; this
    // names the env.
    let result: { measured: boolean } | undefined;
    try {
      result = await refreshSessionStorageMeasurement({
        handle,
        // The holder-neutral seam still names its subject `workspaceId`; here it
        // addresses a `drive_envs` row, which is what `persist` below writes to.
        workspaceId: holderId,
        // The generation just minted — the CAS target for the write. Taken from
        // the HANDLE, never from a row read: this is the VM the `du` actually ran
        // on, and a row re-read could already describe its replacement.
        spriteInstanceId: handle.spriteInstanceId ?? null,
        // NULL, not the row's value: this fires only on the two arms that RESET
        // the measurement columns in the same write — `create` (a new Sprite
        // generation is an empty filesystem) and `adopt` (a replacement VM is a
        // different disk). Passing the pre-provision timestamp would let the
        // throttle skip the baseline measurement of an env rebuilt or replaced
        // inside the window, leaving the row NULL with no other trigger to fix it.
        lastMeasuredAt: null,
        now: new Date(),
        persist: ({ workspaceId, spriteInstanceId, measuredBytes, measuredAt }) =>
          store.recordStorageMeasurement({ envId: workspaceId, spriteInstanceId, measuredBytes, measuredAt }),
      });
    } catch (error) {
      // The PERSIST rejected (a DB blip mid-provision). `refreshSessionStorageMeasurement`
      // swallows exec/parse failures itself and returns `measured: false`; only
      // the write can escape it, and it is the one failure that leaves the row
      // NULL with a perfectly healthy sandbox.
      loggers.ai.error(
        'Env storage measurement could not be persisted — this env has no baseline and will bill the 0 floor until it is measured',
        error instanceof Error ? error : new Error(String(error)),
        { envId: holderId },
      );
      return;
    }

    if (!result.measured) {
      // Not an exception: the `du` failed, timed out, or printed something
      // unparseable, and the helper declined to persist a guess. Correct, and
      // still worth naming — for an env it means the same NULL row.
      loggers.ai.warn(
        'Env storage measurement produced no reading — this env has no baseline and will bill the 0 floor until it is measured',
        { envId: holderId },
      );
    }
  };
}
