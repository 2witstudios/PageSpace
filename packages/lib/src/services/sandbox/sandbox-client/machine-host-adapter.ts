/**
 * Adapts a `MachineHost` back into the `ExecSandboxClient` shape that
 * `machine-session-manager.ts` / `machine-session.ts` / `tool-runners.ts`
 * already consume (PR2/PR3) — so a real `MachineHost` (e.g.
 * `createSpriteMachineHost`) is the thing production actually calls, WITHOUT
 * touching any of that already-tested Epic 1 core or its fakes.
 *
 * This is the actual "re-express the existing Sprite behavior behind the
 * MachineHost interface" plumbing: the production Sprite client factories
 * (`apps/web/src/lib/sandbox/sprites-client.ts`, `apps/realtime/src/index.ts`)
 * build their `ExecSandboxClient` by wrapping a `MachineHost` through this
 * adapter, so real Sprite calls flow through `MachineHost.provision` /
 * `attach` / `kill` / `exec` — never around it. Swapping to a second backend
 * means writing one new `MachineHost` implementation and pointing a factory
 * at it here; none of Epic 1's `SandboxClient`/`ExecSandboxClient` callers
 * (or their tests) change, because they still see the exact same interface
 * they always have.
 */

import type { MachineHost, MachineHandle, MachineSubstrateSpec } from '../machine-host';
import type { ExecSandboxClient, ExecutableSandbox } from './types';

/**
 * Adapt a single `MachineHandle` into the `ExecutableSandbox` shape. Exported
 * (not just used internally by `createExecClientFromMachineHost`) for callers
 * that already hold a freshly-provisioned handle and want to drive it through
 * an `ExecutableSandbox`-shaped helper (e.g. `runGitInSandbox`) without a
 * round-trip through a `MachineHost.attach` lookup — see
 * `services/machines/machine-branches.ts`.
 */
export function adaptMachineHandleToExecutableSandbox(handle: MachineHandle): ExecutableSandbox {
  return {
    sandboxId: handle.machineId,
    egressPolicyToken: handle.egressPolicyToken,
    runCommand: (args) => handle.exec(args),
    writeFiles: (files) => handle.writeFiles(files),
    readFileToBuffer: (args) => handle.readFile(args),
  };
}

/**
 * Build an `ExecSandboxClient` backed by `host`, provisioning every machine
 * with the given `substrate` (today always `{ kind: 'sprite' }` — the only
 * implemented backend; see `../machine-host.ts`).
 */
export function createExecClientFromMachineHost(
  host: MachineHost,
  substrate: MachineSubstrateSpec,
): ExecSandboxClient {
  return {
    async getOrCreate({ name, options, appliedEgressToken }) {
      return adaptMachineHandleToExecutableSandbox(
        await host.provision({ name, substrate, options, appliedEgressToken }),
      );
    },
    async get({ sandboxId }) {
      const handle = await host.attach({ machineId: sandboxId });
      return handle ? adaptMachineHandleToExecutableSandbox(handle) : null;
    },
    async stop({ sandboxId }) {
      await host.kill({ machineId: sandboxId });
    },
  };
}
