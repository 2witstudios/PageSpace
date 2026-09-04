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
 * policy.
 *
 * Deny order is FIXED and tested: no_policy → policy_deny → principal_not_allowed
 * → op_mismatch → op_not_advertised → server_denied → machine_denied | ask →
 * cwd_denied → path_denied. All policy gates run BEFORE any path is confined,
 * so a denied request never reaches the injected `realpath`.
 *
 * On `allow`, the returned `NormalizedRequest` is the ONLY thing the runner
 * may execute: confined cwd and paths (real paths), scrubbed env, and timeout /
 * output caps clamped to the machine's limits (clamping is recorded, not denied,
 * so a long-running agent command degrades to the owner's cap rather than
 * failing).
 */
import type { Grant, GrantOp } from './grant';
import type { AdvertisedCapabilities, MachinePolicy, ServerPolicy } from './policy-types';
import { capabilityForOp } from './intersect-capabilities';
import { confinePath, type Realpath } from './confine-path';
import { scrubEnv } from './scrub-env';

export interface ExecutionRequest {
  readonly op: GrantOp;
  readonly cmd?: string;
  readonly args?: readonly string[];
  /** Working directory; defaults to the machine's first root. */
  readonly cwd?: string;
  /** File paths named by fs operations. Each must confine. */
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
  readonly timeoutMs: number;
  readonly maxBytes: number;
  /** True when timeoutMs or maxBytes were reduced to the machine's cap. */
  readonly clamped: boolean;
}

export type ExecDenyReason =
  | 'no_policy'
  | 'policy_deny'
  | 'principal_not_allowed'
  | 'op_mismatch'
  | 'op_not_advertised'
  | 'server_denied'
  | 'machine_denied'
  | 'cwd_denied'
  | 'path_denied';

export type ExecutionVerdict =
  | { readonly kind: 'allow'; readonly request: NormalizedRequest }
  | { readonly kind: 'ask'; readonly reason: 'op_not_preapproved' }
  | { readonly kind: 'deny'; readonly reason: ExecDenyReason };

export interface DecideExecutionInput {
  readonly grant: Grant;
  readonly request: ExecutionRequest;
  /** `null` when the policy file is missing or unparseable — deny-all. */
  readonly machinePolicy: MachinePolicy | null;
  readonly serverPolicy: ServerPolicy;
  readonly capabilities: AdvertisedCapabilities;
  readonly realpath: Realpath;
}

function deny(reason: ExecDenyReason): ExecutionVerdict {
  return { kind: 'deny', reason };
}

export function decideExecution(input: DecideExecutionInput): ExecutionVerdict {
  const { grant, request, machinePolicy, serverPolicy, capabilities, realpath } = input;

  if (machinePolicy === null) return deny('no_policy');
  if (machinePolicy.mode === 'deny') return deny('policy_deny');
  if (!machinePolicy.principals.includes(grant.principal.userId)) return deny('principal_not_allowed');
  if (grant.op !== request.op) return deny('op_mismatch');

  const op = grant.op;
  if (!capabilities[capabilityForOp(op)]) return deny('op_not_advertised');
  if (!serverPolicy.ops.includes(op)) return deny('server_denied');
  if (!machinePolicy.ops.includes(op)) {
    return machinePolicy.mode === 'ask' ? { kind: 'ask', reason: 'op_not_preapproved' } : deny('machine_denied');
  }

  // Policy gates passed; only now touch path resolution.
  const roots = machinePolicy.roots;
  const primaryRoot = roots[0];
  if (primaryRoot === undefined) return deny('cwd_denied');
  const cwd = confinePath(request.cwd ?? primaryRoot, roots, realpath);
  if (!cwd.ok) return deny('cwd_denied');

  const paths: string[] = [];
  for (const requestedPath of request.paths ?? []) {
    const confined = confinePath(requestedPath, roots, realpath);
    if (!confined.ok) return deny('path_denied');
    paths.push(confined.path);
  }

  const env = scrubEnv(request.env, machinePolicy.envAllowlist);

  const timeoutClamped = request.timeoutMs !== undefined && request.timeoutMs > machinePolicy.maxTimeoutMs;
  const bytesClamped = request.maxBytes !== undefined && request.maxBytes > machinePolicy.maxBytes;
  const timeoutMs = request.timeoutMs === undefined ? machinePolicy.maxTimeoutMs : Math.min(request.timeoutMs, machinePolicy.maxTimeoutMs);
  const maxBytes = request.maxBytes === undefined ? machinePolicy.maxBytes : Math.min(request.maxBytes, machinePolicy.maxBytes);

  return {
    kind: 'allow',
    request: {
      op,
      ...(request.cmd !== undefined && { cmd: request.cmd }),
      ...(request.args !== undefined && { args: request.args }),
      cwd: cwd.path,
      paths,
      env,
      timeoutMs,
      maxBytes,
      clamped: timeoutClamped || bytesClamped,
    },
  };
}
