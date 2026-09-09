/**
 * The LOCAL environment `SandboxHost` — the seam that lets an agent tool call
 * in a web pane reach the user's own computer, with NO change to any tool
 * runner (Local Environments epic, M1 · t09).
 *
 * The whole point of `sandbox-host.ts` is that adding a substrate costs one
 * union member and one host, and nothing that CALLS a host branches on which
 * one it got. So this file is the second host: `exec`, `writeFiles` and
 * `readFile` build the grant frame for the op, hand it to the injected
 * {@link BridgeTransport}, and map the machine's VERIFIED answer back into the
 * seam's own result types.
 *
 * **What this module deliberately does NOT contain.** No `ws`, no
 * `@fly/sprites`, no `@pagespace/db`, and — the load-bearing one — no grant
 * signing, no correlation and no signature verification. All three live once,
 * in t07's `EnvBridgeClient` (apps/web), and the transport below is a thin
 * wrapper over its `sendGrant`. A second verifier that could drift from the
 * first is the exact defect class the adversarial review on this epic caught
 * twice; `transport.sendGrant` resolving is therefore the ONLY statement this
 * module makes about a result's authenticity, and it inherits invariant 7
 * whole (`apps/web/src/lib/env-bridge/result-verifier.ts`).
 *
 * **Seven members refuse, and refuse LOUDLY.** `stream`, `listStreams`,
 * `killSession`, `services.*`, `urlInfo`, `powerState` and `setUrlAuth` throw
 * a typed {@link LocalEnvUnsupportedError} and are advertised as `false` on
 * `handle.capabilities`. None of them returns a degenerate value: an empty
 * `listStreams()` would tell a caller "no shells are running on that machine",
 * which is a claim about the machine rather than about this seam's reach, and
 * that is precisely the silent safety degradation invariant 12 forbids.
 *
 * **Local terminals are permanently outside this seam** — not "not yet". The
 * bridge socket terminates in apps/web while PTYs are driven by apps/realtime,
 * so M2 routes a local PTY through apps/realtime with an HMAC-signed apps/web
 * proxy and an SSE return path (t11/t12). Nobody should ever "finish"
 * `stream()` here.
 */

import {
  LOCAL_ENV_SANDBOX_CAPABILITIES,
  LocalEnvNotConnectedError,
  LocalEnvUnsupportedError,
  localEnvSandboxId,
  type LocalEnvUnsupportedOp,
  type SandboxHandle,
  type SandboxHost,
  type SandboxServicesApi,
} from '../sandbox-host';
import type { MachineResultFrame } from '../../../env-bridge/machine-signatures';
import type { UnsignedGrantFrame } from '../../../env-bridge/grant-args';
import type { RunCommandArgs, SandboxRunResult, WriteFileEntry } from './types';

/**
 * The socket, as this host needs it: send one granted request and resolve with
 * the machine's VERIFIED answer.
 *
 * Injected rather than imported so the host stays I/O-free and testable with
 * an in-memory fake. The production implementation
 * (`apps/web/src/lib/sandbox/local-env-transport.ts`) is bound to one env AND
 * one grant principal, because both are security-relevant identity — which is
 * why neither appears in a per-call argument here where a caller could vary it.
 */
export interface BridgeTransport {
  /**
   * Sign, send and correlate one grant frame. MUST reject rather than resolve
   * when the machine's signature does not verify (invariant 7), when the env
   * has no authorized socket, or when the request times out.
   */
  sendGrant(input: { envId: string; frame: UnsignedGrantFrame }): Promise<MachineResultFrame>;
  /** Does this replica hold an AUTHORIZED bridge socket for the env right now? */
  isConnected(envId: string): boolean;
  /**
   * A stable id for the CURRENT connection, or null when there is none —
   * a new value whenever the daemon reconnects. See
   * {@link SandboxHandle.spriteInstanceId} on the handle below for what it is
   * used as and, more importantly, what it is not.
   */
  connectionEpoch(envId: string): string | null;
}

/** The machine answered a grant with `grant_denied`, or with a result the op cannot use. */
export class LocalEnvGrantDeniedError extends Error {
  constructor(
    readonly envId: string,
    /** The daemon's own deny word (`decideExecution`'s vocabulary), passed through unedited. */
    readonly reason: string,
  ) {
    super(`Local environment ${envId} denied the request: ${reason}`);
    this.name = 'LocalEnvGrantDeniedError';
  }
}

/**
 * PageSpace itself refused to SIGN the grant (`decideSign` in the bridge
 * client): the op is not in the env's `serverPolicy`, or the env is revoked,
 * paused or the feature is off. The daemon never saw a frame. Distinct from
 * {@link LocalEnvGrantDeniedError} (the MACHINE refused) and from a
 * disconnected env, because each has a different owner: this one is fixed on
 * the environment's settings page by the machine's owner, and by nobody else.
 * Thrown by the production transport, which maps the bridge client's typed
 * `server_denied` failure onto it so this package can name it without
 * importing apps/web.
 */
export class LocalEnvServerDeniedError extends Error {
  constructor(
    readonly envId: string,
    /** `decideSign`'s reason word: `flag_disabled | revoked | paused | server_denied`. */
    readonly reason: string,
  ) {
    super(`PageSpace refused to sign the request for local environment ${envId}: ${reason}`);
    this.name = 'LocalEnvServerDeniedError';
  }
}

/** A verified frame arrived, but of a type this op cannot read. Never a silent coercion. */
export class LocalEnvUnexpectedResultError extends Error {
  constructor(
    readonly envId: string,
    readonly expected: MachineResultFrame['type'],
    readonly received: MachineResultFrame['type'],
  ) {
    super(`Local environment ${envId} answered a ${expected} request with a ${received} frame`);
    this.name = 'LocalEnvUnexpectedResultError';
  }
}

/**
 * Narrow a verified result to the frame the op asked for.
 *
 * `grant_denied` becomes a typed denial carrying the DAEMON's reason — the
 * machine is the policy enforcement point (invariant 4), so its word is the
 * answer, not something the server re-decides. Any other mismatch throws
 * rather than being coerced: a `fs_write_result` read as an `exec_result`
 * would produce an exit code out of nothing.
 */
function expectFrame<T extends MachineResultFrame['type']>(
  envId: string,
  frame: MachineResultFrame,
  expected: T,
): Extract<MachineResultFrame, { type: T }> {
  if (frame.type === 'grant_denied') throw new LocalEnvGrantDeniedError(envId, frame.reason);
  if (frame.type !== expected) throw new LocalEnvUnexpectedResultError(envId, expected, frame.type);
  return frame as Extract<MachineResultFrame, { type: T }>;
}

/**
 * The refusal for one unsupported member.
 *
 * REJECTS rather than throwing synchronously, because every member it stands
 * in for is declared `Promise`-returning: a synchronous throw from something a
 * caller wrote `handle.listStreams().catch(...)` around would escape the catch
 * it was written to be caught by, turning a typed refusal into a crash.
 */
function refuseOp(op: LocalEnvUnsupportedOp, envId: string): () => Promise<never> {
  return () => Promise.reject(new LocalEnvUnsupportedError(op, envId));
}

/** Every `services` member refuses identically — one object, built once per handle. */
function unsupportedServices(envId: string): SandboxServicesApi {
  const refuse = refuseOp('services', envId);
  return {
    create: refuse,
    list: refuse,
    get: refuse,
    start: refuse,
    stop: refuse,
    remove: refuse,
  };
}

function buildHandle({ transport, envId }: { transport: BridgeTransport; envId: string }): SandboxHandle {
  return {
    capabilities: LOCAL_ENV_SANDBOX_CAPABILITIES,
    /**
     * NOT a Fly machine id, and nothing may treat it as one.
     *
     * The seam's identity guard exists because a Sprite NAME is reused across
     * re-creates, so a kill or a CAS has to name the VM generation. A local
     * env has the same hazard in a different shape — the daemon can drop and
     * reconnect, and work granted to the old connection must not be credited
     * to the new one — so this carries the transport's CONNECTION EPOCH: a
     * stable value for as long as one socket lives, a different one after a
     * reconnect. Invariant 9 keeps `drive_envs.spriteInstanceId` NULL for a
     * local env, so this is never persisted anywhere.
     */
    spriteInstanceId: transport.connectionEpoch(envId),
    sandboxId: localEnvSandboxId(envId),
    /**
     * Undefined, and the boundary is worth naming: `egressPolicyToken` is
     * proof that an EGRESS LOCKDOWN was applied to a specific VM we control.
     * There is no such lockdown here and there could not be — the machine is
     * the user's own computer on the user's own network, and PageSpace has no
     * standing to firewall it. Undefined is the seam's "unproven", so the
     * caller records nothing; it must never be read as "locked down".
     */
    egressPolicyToken: undefined,

    async exec(args: RunCommandArgs): Promise<SandboxRunResult> {
      const frame: UnsignedGrantFrame = {
        type: 'grant_exec',
        cmd: args.cmd,
        ...(args.args !== undefined && { args: args.args }),
        ...(args.cwd !== undefined && { cwd: args.cwd }),
        ...(args.env !== undefined && { env: args.env }),
        ...(args.timeoutMs !== undefined && { timeoutMs: args.timeoutMs }),
        ...(args.maxBytes !== undefined && { maxBytes: args.maxBytes }),
      };
      const result = expectFrame(envId, await transport.sendGrant({ envId, frame }), 'exec_result');
      return {
        exitCode: result.exitCode,
        stdout: Buffer.from(result.stdoutB64, 'base64').toString('utf8'),
        stderr: Buffer.from(result.stderrB64, 'base64').toString('utf8'),
      };
    },

    async writeFiles(files: WriteFileEntry[]): Promise<void> {
      // Content is part of the SIGNED projection (`grant-args.ts`), so a grant
      // to write one thing cannot be replayed to write another to the path.
      const frame: UnsignedGrantFrame = {
        type: 'grant_fs_write',
        files: files.map((file) => ({
          path: file.path,
          contentB64: Buffer.from(typeof file.content === 'string' ? Buffer.from(file.content, 'utf8') : file.content).toString('base64'),
          ...(file.mode !== undefined && { mode: file.mode }),
        })),
      };
      const result = expectFrame(envId, await transport.sendGrant({ envId, frame }), 'fs_write_result');
      // The daemon reports a per-request outcome inside a verified frame; a
      // failed write is an ERROR here because `writeFiles` resolves as proof
      // the bytes landed and every caller acts on that.
      if (!result.ok) throw new LocalEnvGrantDeniedError(envId, result.error ?? 'fs_write_failed');
    },

    async readFile(args: { path: string }): Promise<Buffer | null> {
      const frame: UnsignedGrantFrame = { type: 'grant_fs_read', paths: [args.path] };
      const result = expectFrame(envId, await transport.sendGrant({ envId, frame }), 'fs_read_result');
      // `found: false` is the seam's documented null (a missing file), not a
      // failure — same shape the Sprite host answers with.
      if (!result.found) return null;
      return Buffer.from(result.contentB64 ?? '', 'base64');
    },

    stream: refuseOp('stream', envId),
    listStreams: refuseOp('listStreams', envId),
    killSession: refuseOp('killSession', envId),
    createCheckpoint: refuseOp('createCheckpoint', envId),
    services: unsupportedServices(envId),
    urlInfo: refuseOp('urlInfo', envId),
    powerState: refuseOp('powerState', envId),
    setUrlAuth: refuseOp('setUrlAuth', envId),
  };
}

/**
 * Build the local environment's `SandboxHost`.
 *
 * Per-env and per-request — deliberately NOT a process singleton like the
 * Sprite host: the transport it closes over is bound to one env and one grant
 * principal, and caching that across requests would let one user's host serve
 * another user's call.
 */
export function createLocalEnvSandboxHost({
  transport,
  envId,
}: {
  transport: BridgeTransport;
  envId: string;
}): SandboxHost {
  const handleOrThrow = (): SandboxHandle => {
    // "Connected" is checked HERE as well as inside the transport because the
    // two failures are different answers: no socket is `LocalEnvNotConnectedError`
    // (run `pagespace env connect`), while a socket that drops mid-request is
    // the transport's own typed `disconnected`.
    if (!transport.isConnected(envId)) throw new LocalEnvNotConnectedError(envId);
    return buildHandle({ transport, envId });
  };

  return {
    /**
     * Bind to the LIVE connection. There is nothing to create: the machine
     * exists whether or not PageSpace is looking at it, and the daemon owns
     * its own lifecycle. A disconnected env throws rather than queueing —
     * a bind never waits on a machine that may never come back.
     */
    async provision({ substrate }) {
      // Defensive, and cheap: a host built for env A must never serve a
      // provision addressed to env B, however it was resolved.
      if (substrate.kind === 'local' && substrate.envId !== envId) {
        throw new LocalEnvNotConnectedError(substrate.envId);
      }
      return handleOrThrow();
    },

    /** Null when the daemon is not connected — the seam's "it has vanished", exactly as the Sprite host answers for a Sprite the platform no longer has. */
    async attach() {
      if (!transport.isConnected(envId)) return null;
      return buildHandle({ transport, envId });
    },

    /**
     * A NON-DESTRUCTIVE disconnect: nothing is sent, nothing is destroyed, and
     * this resolves successfully.
     *
     * Three separate reasons, any one of which would be enough. The machine is
     * the user's own computer — "kill" would mean powering down someone's
     * laptop because a session ended. The DAEMON owns its lifecycle
     * (`pagespace env disconnect`, Ctrl-C, revoke) and invariant 8 says the
     * local side always wins. And invariant 9 keeps every Sprite column NULL
     * on a local row, so there is no `sandboxId` to release, no reclaim row to
     * enqueue, and nothing for `machine_sprite_reclaims` to gain: a local env
     * is structurally invisible to reclaim and billing, and this method
     * touching either would be the leak that makes it visible.
     */
    async kill() {
      return;
    },
  };
}
