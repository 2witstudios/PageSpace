/**
 * Which `SandboxHost` serves a given substrate — the kind-dispatching registry
 * (Local Environments epic, M1 · t09).
 *
 * `sandbox-host.ts`'s own header states the extension contract: a second
 * backend is one new `kind` member plus one new host, and no existing caller
 * branches on `kind`. This module is where that dispatch happens ONCE, so it
 * does not happen in eight places.
 *
 * **`getSandboxHost()` is untouched and stays exported from
 * `sandbox-host-runtime.ts`.** Branches, the git-blob runtime, the shell
 * runtime and half a dozen others consume it and every one of them is
 * Sprite-only by construction; making them go through a substrate they do not
 * have would be churn with no safety gained.
 *
 * The Sprite host is a process singleton (one driver, one guarded ESM import).
 * A local host deliberately is NOT cached: it closes over a transport bound to
 * one env AND one grant principal, so a cached instance would sign a second
 * user's requests with the first user's identity.
 */
import type { GrantPrincipal } from '@pagespace/lib/env-bridge/grant';
import { createLocalEnvSandboxHost } from '@pagespace/lib/services/sandbox/sandbox-client/local-env-sandbox-host';
import { parseLocalEnvSandboxId, type SandboxHost, type SandboxSubstrateSpec } from '@pagespace/lib/services/sandbox/sandbox-host';
import { createLocalEnvTransport } from '@/lib/sandbox/local-env-transport';
import { getSandboxHost } from './sandbox-host-runtime';

/**
 * The host for `substrate`.
 *
 * `principal` is the identity a LOCAL env's grants are signed under. Omitting
 * it yields a host that can BIND (provision/attach ask only whether the
 * machine is connected) but whose first grant would be refused — see
 * `LocalEnvNoPrincipalError`. The Sprite branch has no use for it: a Sprite is
 * addressed by name and its authorization happened at the gate.
 */
export async function resolveSandboxHost(
  substrate: SandboxSubstrateSpec,
  principal?: GrantPrincipal,
): Promise<SandboxHost> {
  if (substrate.kind === 'local') {
    return createLocalEnvSandboxHost({
      transport: createLocalEnvTransport(principal === undefined ? {} : { principal }),
      envId: substrate.envId,
    });
  }
  return getSandboxHost();
}

/**
 * The host for a sandbox ADDRESS — what a caller that holds only an opaque
 * `sandboxId` needs (the agent tool runner's `reconnect`, which is handed one
 * by `acquireSandbox` and has no substrate in hand).
 *
 * A local env holds no `drive_envs.sandboxId` (invariant 9), so its address is
 * derived rather than stored — `localEnvSandboxId`. Every other id is a Sprite
 * name, which is why the parse, not a lookup, is what decides: an id that is
 * not a local address is a Sprite address, with no third case and no database
 * round-trip to get it wrong.
 */
export async function resolveSandboxHostForSandboxId(
  sandboxId: string,
  principal: GrantPrincipal,
): Promise<SandboxHost> {
  // Required here, unlike above: every caller of this overload holds a live
  // request and is about to RUN something.
  const envId = parseLocalEnvSandboxId(sandboxId);
  return resolveSandboxHost(envId === null ? { kind: 'sprite' } : { kind: 'local', envId }, principal);
}
