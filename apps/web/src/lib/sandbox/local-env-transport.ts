/**
 * The production `BridgeTransport` — the one concrete socket the local-env
 * `SandboxHost` (`@pagespace/lib`) sends through.
 *
 * **This module is a WRAPPER and must stay one.** Grant signing (invariant 3),
 * correlation by `grantId`, and machine-signature verification (invariant 7)
 * all live exactly once, in t07's `EnvBridgeClient.sendGrant`
 * (`@/lib/env-bridge/bridge-client`). Nothing here re-implements any of the
 * three, and `__tests__/local-env-transport.test.ts` asserts that by reading
 * this file: two verification paths that can drift is the precise defect class
 * the adversarial review on this epic caught twice, and it is not detectable
 * from behavior — both paths pass their own tests right up until one of them
 * stops rejecting something.
 *
 * A transport is built per env AND per grant principal, never cached: the
 * principal is signed into every grant, so a shared instance would let one
 * user's request run under another user's name.
 */
import type { GrantPrincipal } from '@pagespace/lib/env-bridge/grant';
import { LocalEnvServerDeniedError, type BridgeTransport } from '@pagespace/lib/services/sandbox/sandbox-client/local-env-sandbox-host';
import { EnvBridgeError, getEnvBridgeClient } from '@/lib/env-bridge/bridge-client';
import { getAuthorizedEnvConnection, getEnvConnectionMetadata } from '@/lib/websocket/ws-env-connections';

/**
 * A stable id for the CURRENT bridge connection of an env.
 *
 * Derived from facts the registry already holds for the live socket — the
 * `env:bridge` session it authenticated with and the moment it connected — so
 * it changes on every reconnect and on every supersede, and never changes
 * while one socket lives. That is the property `SandboxHandle.spriteInstanceId`
 * needs from it: an identity for THIS generation of the connection, so work
 * granted to a socket that has since been replaced is not credited to its
 * replacement. It is emphatically not a Fly machine id and nothing persists it
 * (invariant 9 keeps `drive_envs.spriteInstanceId` NULL for a local env).
 */
function readConnectionEpoch(envId: string): string | null {
  const ws = getAuthorizedEnvConnection(envId);
  if (!ws) return null;
  const metadata = getEnvConnectionMetadata(ws);
  if (!metadata) return null;
  return `${metadata.sessionId}:${metadata.connectedAt.getTime()}`;
}

/**
 * A transport built for a bind that carries NO grant principal, and therefore
 * may not send a grant.
 *
 * `SandboxHost.provision`/`attach` on a local env ask one question — is the
 * machine connected — and a provisioning path has no conversation to name. The
 * alternative to this type is an invented placeholder principal, which would
 * be an identity nobody authorized riding inside a signed grant. So the
 * refusal is structural: `sendGrant` rejects, loudly, and any future edit that
 * tries to run a command from the provisioning path fails instead of
 * succeeding under a fabricated name.
 */
export class LocalEnvNoPrincipalError extends Error {
  constructor(readonly envId: string) {
    super(
      `Refusing to send a grant to ${envId}: this transport was built for a connectivity bind and carries no grant principal. `
        + 'Build one for the acting principal (see createLocalEnvTransport).',
    );
    this.name = 'LocalEnvNoPrincipalError';
  }
}

/**
 * Build the transport for one env, acting as one principal.
 *
 * `principal` is the identity signed into every grant this transport sends —
 * the acting user, and the session/conversation the request came through. The
 * daemon's audit log keys on it, and so does the local ask/allowlist prompt
 * the machine's owner sees. Omit it only for a connectivity bind (see
 * {@link LocalEnvNoPrincipalError}).
 */
export function createLocalEnvTransport(options: { principal?: GrantPrincipal } = {}): BridgeTransport {
  const { principal } = options;
  return {
    sendGrant: ({ envId, frame }) =>
      principal === undefined
        ? Promise.reject(new LocalEnvNoPrincipalError(envId))
        : getEnvBridgeClient()
            .sendGrant({ envId, frame, principal })
            .catch((error: unknown) => {
              // The server's own refusal to SIGN (GA wave 1) crosses into
              // `@pagespace/lib` as the typed error that package can name, so
              // the tool layer answers `local_server_denied` rather than a
              // generic execution failure. Every other failure passes through
              // untouched — this is a re-label, not a second decision.
              if (error instanceof EnvBridgeError && error.kind === 'server_denied') {
                const reason = typeof error.detail?.reason === 'string' ? error.detail.reason : 'server_denied';
                throw new LocalEnvServerDeniedError(envId, reason);
              }
              // Stop (GA wave 3): an in-flight request the OWNER paused is the
              // server's refusal too, in the same typed word `decideSign` uses
              // for a new one — the tool names "the owner stopped it", never a
              // transport failure.
              if (error instanceof EnvBridgeError && error.kind === 'paused') throw new LocalEnvServerDeniedError(envId, 'paused');
              throw error;
            }),
    // The AUTHORIZED socket only (invariant 6): a socket whose signed hello has
    // not verified is not a machine we may send a grant to, so it is not a
    // connection as far as this seam is concerned.
    isConnected: (envId) => getAuthorizedEnvConnection(envId) !== undefined,
    connectionEpoch: readConnectionEpoch,
  };
}
