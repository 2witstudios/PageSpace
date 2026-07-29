/**
 * Adapts a `SandboxHost` back into the `ExecSandboxClient` shape that
 * `machine-session-manager.ts` / `machine-session.ts` / `tool-runners.ts`
 * already consume (PR2/PR3) — so a real `SandboxHost` (e.g.
 * `createSpriteSandboxHost`) is the thing production actually calls, WITHOUT
 * touching any of that already-tested Epic 1 core or its fakes.
 *
 * This is the actual "re-express the existing Sprite behavior behind the
 * SandboxHost interface" plumbing: the production Sprite client factories
 * (`apps/web/src/lib/sandbox/sprites-client.ts`, `apps/realtime/src/index.ts`)
 * build their `ExecSandboxClient` by wrapping a `SandboxHost` through this
 * adapter, so real Sprite calls flow through `SandboxHost.provision` /
 * `attach` / `kill` / `exec` — never around it. Swapping to a second backend
 * means writing one new `SandboxHost` implementation and pointing a factory
 * at it here; none of Epic 1's `SandboxClient`/`ExecSandboxClient` callers
 * (or their tests) change, because they still see the exact same interface
 * they always have.
 */

import type { SandboxHost, SandboxHandle, SandboxSubstrateSpec } from '../sandbox-host';
import type { ExecSandboxClient, ExecutableSandbox } from './types';

/**
 * Adapt a single `SandboxHandle` into the `ExecutableSandbox` shape. Exported
 * (not just used internally by `createExecClientFromSandboxHost`) for callers
 * that already hold a freshly-provisioned handle and want to drive it through
 * an `ExecutableSandbox`-shaped helper (e.g. `runGitInSandbox`) without a
 * round-trip through a `SandboxHost.attach` lookup — see
 * `services/machines/machine-branches.ts`.
 */
export function adaptSandboxHandleToExecutableSandbox(handle: SandboxHandle): ExecutableSandbox {
  return {
    sandboxId: handle.sandboxId,
    // WHICH VM this is. Dropping it here (as this adapter used to) is invisible:
    // `sandboxId` is only the reused name, so everything still "works" while every
    // identity guard downstream silently degrades to name-only.
    spriteInstanceId: handle.spriteInstanceId ?? null,
    egressPolicyToken: handle.egressPolicyToken,
    runCommand: (args) => handle.exec(args),
    writeFiles: (files) => handle.writeFiles(files),
    readFileToBuffer: (args) => handle.readFile(args),
    createCheckpoint: (comment) => handle.createCheckpoint(comment),
  };
}

/**
 * Build an `ExecSandboxClient` backed by `host`, provisioning every machine
 * with the given `substrate` (today always `{ kind: 'sprite' }` — the only
 * implemented backend; see `../sandbox-host.ts`).
 */
export function createExecClientFromSandboxHost(
  host: SandboxHost,
  substrate: SandboxSubstrateSpec,
): ExecSandboxClient {
  return {
    async getOrCreate({ name, options, appliedEgressToken }) {
      return adaptSandboxHandleToExecutableSandbox(
        await host.provision({ name, substrate, options, appliedEgressToken }),
      );
    },
    async get({ sandboxId }) {
      const handle = await host.attach({ sandboxId });
      return handle ? adaptSandboxHandleToExecutableSandbox(handle) : null;
    },
    async stop({ sandboxId }) {
      await host.kill({ sandboxId });
    },
  };
}
