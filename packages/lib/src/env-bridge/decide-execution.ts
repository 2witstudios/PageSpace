/**
 * The daemon's execution decision (invariant 4): given a grant that has
 * ALREADY passed `verifyGrant`, may this request run on the user's machine —
 * and if so, in what exact, normalized form?
 *
 * The daemon is the policy enforcement point. Server-side gating is necessary
 * but never sufficient: this function consults the machine owner's local policy
 * independently, and a request the server considers allowed but the machine
 * does not is denied. Effective permission is the intersection of the machine's
 * advertised capabilities, the drive's server policy, and the local machine
 * policy. (Those three checks are kept inline rather than routed through
 * `intersectCapabilities` so each failure keeps its own deny reason for the
 * audit log; `intersectCapabilities` is the single-boolean form used for
 * `hello` and UI.)
 *
 * WHAT CONFINEMENT COVERS — stated plainly so M1's negatives test the right
 * thing. Roots confine the paths an agent NAMES: every fs-op path and every
 * cwd must resolve inside a root. Roots do NOT sandbox what a command does
 * once it runs: `exec` with cwd inside a root may still `cat /etc/passwd`.
 * That is by design at this layer — `exec` is gated by the owner's
 * ask/allowlist policy and by the server policy, not by path confinement.
 * (Founder decision recorded on the epic page; if `exec` should ever be
 * root-confined, that is a runner-level sandbox, not a change here.)
 *
 * Deny order is FIXED and tested for every adjacent pair: malformed →
 * no_policy → policy_deny → principal_not_allowed → op_mismatch →
 * op_not_advertised → server_denied → machine_denied → cwd_denied →
 * path_denied → approval_expired → approval_mismatch → then `ask` or `allow`. `malformed` runs
 * FIRST so "allow" always means "executable": an exec without a command or an
 * fs op without paths never reaches the runner as an allow. All policy gates
 * run BEFORE any path is confined, so a request denied by policy never reaches
 * the probe. Deny always beats ask: an owner is only ever asked about a
 * request that would otherwise run.
 *
 * THE ASK → ALLOW SEAM. In `ask` mode, an op that is not pre-approved is
 * confined and scrubbed FIRST, and the `ask` verdict carries that exact
 * `NormalizedRequest` — the owner sees precisely the cwd, paths, env, and caps
 * they are approving. Approval comes back as `localApproval` on a second call,
 * which yields `allow` with the same normalized request. Contract for the
 * daemon adapter (t08), because this function has no clock and the grant is
 * single-use:
 *   - `verifyGrant` burns the nonce on its first ok. The adapter MUST hold the
 *     already-verified `Grant` across the prompt and call this function again
 *     with it; it must NEVER re-verify the wire grant after asking.
 *   - The grant's `exp` bounds the WHOLE authorization, prompt included. A
 *     human answer that arrives after `exp` is refused here as
 *     `approval_expired` — the adapter supplies `approvedAt` from its clock
 *     and does not get to decide otherwise. A late approval means the agent
 *     must request again with a fresh grant.
 *   - An approval is bound to one `grantId` AND to the exact `NormalizedRequest`
 *     the owner saw: the adapter passes the `ask` verdict's request back as
 *     `localApproval.request`, this function re-normalizes and requires a
 *     byte-identical result (`approval_mismatch` otherwise). It never mutates
 *     the policy.
 *
 * On `allow`, the `NormalizedRequest` is the ONLY thing the runner may execute:
 * confined cwd and paths (real paths), scrubbed env, and timeout / output caps
 * clamped to the machine's limits. A limit that is missing, non-integer,
 * non-finite, or non-positive is replaced by the owner's cap — `child_process`
 * treats `timeout: 0` / `NaN` as DISABLED, so a bogus value must never reach
 * it. Clamping is recorded, not denied, so a long-running agent command
 * degrades to the owner's cap rather than failing.
 */
import { canonicalizeArgs, type Grant, type GrantOp } from './grant';
import type { AdvertisedCapabilities, MachinePolicy, ServerPolicy } from './policy-types';
import { capabilityForOp } from './intersect-capabilities';
import { confinePath, type PathResolver } from './confine-path';
import { scrubEnv } from './scrub-env';

export interface ExecutionRequest {
  readonly op: GrantOp;
  /** Required (non-blank) for `exec`. */
  readonly cmd?: string;
  readonly args?: readonly string[];
  /** Working directory; defaults to the machine's first root. */
  readonly cwd?: string;
  /** File paths named by fs operations; required (non-empty) for `fs_read` / `fs_write`. Each must confine. */
  readonly paths?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

export interface NormalizedRequest {
  readonly op: GrantOp;
  readonly cmd?: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly paths: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** Always a positive integer ≤ the owner's cap. */
  readonly timeoutMs: number;
  /** Always a positive integer ≤ the owner's cap. */
  readonly maxBytes: number;
  /** True when a requested limit was not honoured as given (too large, or bogus). */
  readonly clamped: boolean;
}

export type ExecDenyReason =
  | 'malformed'
  | 'no_policy'
  | 'policy_deny'
  | 'principal_not_allowed'
  | 'op_mismatch'
  | 'op_not_advertised'
  | 'server_denied'
  | 'machine_denied'
  | 'cwd_denied'
  | 'path_denied'
  | 'approval_expired'
  | 'approval_mismatch';

export type ExecutionVerdict =
  | { readonly kind: 'allow'; readonly request: NormalizedRequest }
  | { readonly kind: 'ask'; readonly reason: 'op_not_preapproved'; readonly request: NormalizedRequest }
  | { readonly kind: 'deny'; readonly reason: ExecDenyReason };

/**
 * The owner's answer to an `ask` verdict, bound to the grant it was asked
 * about AND to the exact request the owner saw. `approvedAt` (ms since epoch,
 * from the adapter's clock) is compared to the grant's `exp`; an approval after
 * expiry is refused. `request` is the `NormalizedRequest` carried by the `ask`
 * verdict: on approval the request is normalized AGAIN and must be byte-
 * identical, so filesystem drift between prompt and answer (an in-root symlink
 * retargeted from `a` to `b`) can never execute something the owner did not see.
 */
export interface LocalApproval {
  readonly grantId: string;
  readonly approvedAt: number;
  readonly request: NormalizedRequest;
}

export interface DecideExecutionInput {
  readonly grant: Grant;
  readonly request: ExecutionRequest;
  /** `null` when the policy file is missing or unparseable — deny-all. */
  readonly machinePolicy: MachinePolicy | null;
  readonly serverPolicy: ServerPolicy;
  readonly capabilities: AdvertisedCapabilities;
  readonly probe: PathResolver;
  readonly localApproval?: LocalApproval;
}

function deny(reason: ExecDenyReason): ExecutionVerdict {
  return { kind: 'deny', reason };
}

/** Byte equality without short-circuiting on the first difference. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/**
 * Shape check: does this request carry what its op needs to be executable at
 * all — and is every field the TYPE the code below assumes? The request comes
 * off the wire, so a hostile frame (`paths: [null]`, `cwd: 42`, `env: 'x'`)
 * must be a `malformed` deny here, never a thrown TypeError further down.
 */
function isWellFormed(request: ExecutionRequest): boolean {
  // Off the wire: inspect as an untyped record so hostile field types are caught, not assumed.
  const r = request as unknown as Record<string, unknown>;
  if (r.cwd !== undefined && !isNonEmptyString(r.cwd)) return false;
  if (r.cmd !== undefined && typeof r.cmd !== 'string') return false;
  if (r.args !== undefined && !(Array.isArray(r.args) && r.args.every((a) => typeof a === 'string'))) return false;
  if (r.paths !== undefined && !(Array.isArray(r.paths) && r.paths.every(isNonEmptyString))) return false;
  if (r.env !== undefined && (r.env === null || typeof r.env !== 'object' || Array.isArray(r.env))) return false;
  if (r.timeoutMs !== undefined && typeof r.timeoutMs !== 'number') return false;
  if (r.maxBytes !== undefined && typeof r.maxBytes !== 'number') return false;

  switch (request.op) {
    case 'exec':
      return typeof request.cmd === 'string' && request.cmd.trim().length > 0;
    case 'fs_read':
    case 'fs_write':
      return Array.isArray(request.paths) && request.paths.length > 0;
    case 'pty_open':
      return true;
    default:
      return false;
  }
}

/**
 * Resolve a requested limit against the owner's cap. Anything that is not a
 * positive integer is treated as "use the cap" and reported as clamped.
 */
function resolveLimit(requested: number | undefined, cap: number): { readonly value: number; readonly clamped: boolean } {
  if (requested === undefined) return { value: cap, clamped: false };
  if (!Number.isInteger(requested) || requested <= 0) return { value: cap, clamped: true };
  return requested > cap ? { value: cap, clamped: true } : { value: requested, clamped: false };
}

/**
 * Decide whether a verified grant's request may run on this machine.
 * @returns `allow` with the only request the runner may execute, `ask` with
 * the same normalized request for the owner to approve, or a closed-union deny.
 */
export function decideExecution(input: DecideExecutionInput): ExecutionVerdict {
  const { grant, request, machinePolicy, serverPolicy, capabilities, probe, localApproval } = input;

  if (!isWellFormed(request)) return deny('malformed');
  if (machinePolicy === null) return deny('no_policy');
  if (machinePolicy.mode === 'deny') return deny('policy_deny');
  if (!machinePolicy.principals.includes(grant.principal.userId)) return deny('principal_not_allowed');
  if (grant.op !== request.op) return deny('op_mismatch');

  const op = grant.op;
  if (!capabilities[capabilityForOp(op)]) return deny('op_not_advertised');
  if (!serverPolicy.ops.includes(op)) return deny('server_denied');
  const preapproved = machinePolicy.ops.includes(op);
  if (!preapproved && machinePolicy.mode !== 'ask') return deny('machine_denied');

  // Policy gates passed; only now touch path resolution.
  const roots = machinePolicy.roots;
  const primaryRoot = roots[0];
  if (primaryRoot === undefined) return deny('cwd_denied');
  const cwd = confinePath(request.cwd ?? primaryRoot, roots, probe);
  if (!cwd.ok) return deny('cwd_denied');

  const paths: string[] = [];
  for (const requestedPath of request.paths ?? []) {
    const confined = confinePath(requestedPath, roots, probe);
    if (!confined.ok) return deny('path_denied');
    paths.push(confined.path);
  }

  const env = scrubEnv(request.env, machinePolicy.envAllowlist);
  const timeout = resolveLimit(request.timeoutMs, machinePolicy.maxTimeoutMs);
  const bytes = resolveLimit(request.maxBytes, machinePolicy.maxBytes);

  const normalized: NormalizedRequest = {
    op,
    ...(request.cmd !== undefined && { cmd: request.cmd }),
    ...(request.args !== undefined && { args: request.args }),
    cwd: cwd.path,
    paths,
    env,
    timeoutMs: timeout.value,
    maxBytes: bytes.value,
    clamped: timeout.clamped || bytes.clamped,
  };

  if (preapproved) return { kind: 'allow', request: normalized };
  if (localApproval !== undefined && localApproval.grantId === grant.grantId) {
    // The grant bounds the whole authorization, prompt included.
    if (!Number.isFinite(localApproval.approvedAt) || localApproval.approvedAt > grant.exp) return deny('approval_expired');
    // The approval is for the request the owner SAW. Anything that drifted
    // since — filesystem resolution, a tampered copy — is not what was approved.
    if (!sameBytes(canonicalizeArgs(localApproval.request), canonicalizeArgs(normalized))) return deny('approval_mismatch');
    return { kind: 'allow', request: normalized };
  }
  return { kind: 'ask', reason: 'op_not_preapproved', request: normalized };
}
