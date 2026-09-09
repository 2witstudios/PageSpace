/**
 * deployer — the blue/green machine swap.
 *
 * THE RULE THIS MODULE ENFORCES, and the only one that matters: THE OLD MACHINE
 * KEEPS SERVING UNTIL A NEW ONE HAS PROVED ITSELF. Create the new machine, wait for
 * it to reach `started`, ask it (via exec) whether the app inside is actually
 * answering, record it as the app's machine, and only then destroy the old one.
 * Every failure before that last step destroys the NEW machine and leaves the old
 * one untouched — a failed deploy is a no-op for the user, never an outage.
 *
 * WHY A SWAP RATHER THAN AN UPDATE: a Fly machine's rootfs is assembled at CREATE,
 * not at start. An image change is therefore not something a running machine can be
 * talked into; `updateMachineConfig` (the client's only sanctioned mutation path,
 * which this module deliberately never calls) would replace the config in place and
 * still be the wrong tool — a full-config replace on a live machine is how you
 * silently delete its `services` while an app is serving traffic through them.
 *
 * ORDERING, precisely, and each step is where it is for a reason:
 *   1. create new  — named after the digest, so a retry converges instead of
 *                    double-billing.
 *   2. wait started — Fly's own long poll, not a loop of ours.
 *   3. exec health  — `started` means the VM booted, NOT that the app serves.
 *   4. PROMOTE      — the database points at the new machine BEFORE the old one
 *                     dies. Reverse this and a crash in between leaves a row whose
 *                     `machineId` names a machine that no longer exists: an app we
 *                     are billing for and cannot stop.
 *   5. destroy old  — after promotion, and a failure here is NOT a deploy failure.
 *                     The new machine is live and recorded; an undestroyed old
 *                     machine is a billing leak for the reaper, and rolling the
 *                     deploy back over it would take a working app offline.
 */

import type { Machine, MachineConfig } from '../fly/flaps-client';

/** The Fly operations a deploy needs, already bound to one app. */
export interface DeployerFlaps {
  createMachine(input: { name: string; region?: string; config: MachineConfig }): Promise<Machine>;
  waitForState(machineId: string, state: string, timeoutSeconds: number): Promise<void>;
  exec(machineId: string, command: string[], timeoutSeconds: number): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
  deleteMachine(machineId: string): Promise<void>;
}

/**
 * The default health probe: ask the app, from inside its own machine, for a
 * response on the port the router will forward to.
 *
 * Alpine-based runtimes have `/bin/sh` and `wget`, which is why the epic's slim
 * base is alpine-or-distroless rather than distroless alone — a distroless image
 * has no shell for this command to run in and must supply its own probe through
 * `healthCommand`. That is a real constraint on the runtime contract, not an
 * oversight: an image we cannot ask "are you serving?" is one we can only deploy
 * blind.
 */
export const DEFAULT_HEALTH_COMMAND: readonly string[] = [
  '/bin/sh',
  '-c',
  'wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1',
];

/**
 * How long to wait for the new machine to reach `started`. Generous because rootfs
 * assembly at create is 10–20s and a cold pull of a fat image is slower; a wait
 * that expires early destroys a machine that was about to work.
 */
export const DEFAULT_START_WAIT_SECONDS = 120;
export const DEFAULT_HEALTH_TIMEOUT_SECONDS = 30;

export type DeployStage = 'create' | 'wait' | 'health' | 'promote';

export interface DeployBlueGreenInput {
  flaps: DeployerFlaps;
  machineName: string;
  config: MachineConfig;
  region?: string;
  /** The machine currently serving, destroyed only after a successful promotion. */
  oldMachineId: string | null;
  healthCommand?: readonly string[];
  startWaitSeconds?: number;
  healthTimeoutSeconds?: number;
  /**
   * Record the new machine as the app's machine. Returning false REFUSES the
   * promotion (an illegal transition, a row that moved underneath us) and rolls the
   * deploy back — the callback is the database's veto, not a notification.
   */
  promote(newMachineId: string): Promise<boolean>;
}

export type DeployResult =
  | {
      ok: true;
      machineId: string;
      /** False when the old machine outlived the swap — a billing leak, not a deploy failure. */
      oldMachineDestroyed: boolean;
      oldMachineError?: string;
    }
  | {
      ok: false;
      stage: DeployStage;
      error: string;
      /** Whether the new machine was successfully cleaned up. False leaves an orphan. */
      rolledBack: boolean;
      rollbackError?: string;
    };

export async function deployBlueGreen(input: DeployBlueGreenInput): Promise<DeployResult> {
  const {
    flaps,
    machineName,
    config,
    region,
    oldMachineId,
    healthCommand = DEFAULT_HEALTH_COMMAND,
    startWaitSeconds = DEFAULT_START_WAIT_SECONDS,
    healthTimeoutSeconds = DEFAULT_HEALTH_TIMEOUT_SECONDS,
    promote,
  } = input;

  // STEP 1 — create. Failing here is the one stage with nothing to roll back: the
  // create is name-keyed, so either it landed (and the error was the response) or
  // it did not, and the next attempt converges on the same name either way.
  let machine: Machine;
  try {
    machine = await flaps.createMachine({ name: machineName, region, config });
  } catch (error) {
    return { ok: false, stage: 'create', error: describe(error), rolledBack: true };
  }

  const newMachineId = machine.id;
  if (!newMachineId) {
    return {
      ok: false,
      stage: 'create',
      error: 'Fly returned a machine with no id',
      rolledBack: false,
    };
  }

  // STEP 2 — started. STEP 3 — actually serving. Both roll back to the same place.
  try {
    await flaps.waitForState(newMachineId, 'started', startWaitSeconds);
  } catch (error) {
    return rollback(flaps, newMachineId, 'wait', describe(error));
  }

  try {
    const health = await flaps.exec(newMachineId, [...healthCommand], healthTimeoutSeconds);
    if (health.exitCode !== 0) {
      return rollback(
        flaps,
        newMachineId,
        'health',
        `Health check exited ${health.exitCode}: ${(health.stderr || health.stdout).trim().slice(0, 500)}`,
      );
    }
  } catch (error) {
    return rollback(flaps, newMachineId, 'health', describe(error));
  }

  // STEP 4 — promote BEFORE the old machine dies.
  let promoted: boolean;
  try {
    promoted = await promote(newMachineId);
  } catch (error) {
    return rollback(flaps, newMachineId, 'promote', describe(error));
  }
  if (!promoted) {
    return rollback(
      flaps,
      newMachineId,
      'promote',
      'The published app row refused to record the new machine',
    );
  }

  // STEP 5 — the old machine. Past the point of no return: the app is live on the
  // new machine and the database says so, so a failure here is reported alongside a
  // SUCCESSFUL deploy rather than undoing one.
  if (oldMachineId === null || oldMachineId === newMachineId) {
    return { ok: true, machineId: newMachineId, oldMachineDestroyed: true };
  }
  try {
    await flaps.deleteMachine(oldMachineId);
    return { ok: true, machineId: newMachineId, oldMachineDestroyed: true };
  } catch (error) {
    return {
      ok: true,
      machineId: newMachineId,
      oldMachineDestroyed: false,
      oldMachineError: describe(error),
    };
  }
}

/**
 * Destroy the machine this deploy created and report the original failure.
 *
 * A rollback that ITSELF fails leaves a billable machine nobody is serving from, so
 * it is reported (`rolledBack: false`) rather than swallowed — but it never
 * replaces the reason the deploy failed, which is what an operator is actually
 * looking for. The old machine is not touched on any path through here.
 */
async function rollback(
  flaps: DeployerFlaps,
  newMachineId: string,
  stage: DeployStage,
  error: string,
): Promise<DeployResult> {
  try {
    await flaps.deleteMachine(newMachineId);
    return { ok: false, stage, error, rolledBack: true };
  } catch (rollbackError) {
    return { ok: false, stage, error, rolledBack: false, rollbackError: describe(rollbackError) };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
