/**
 * The machine owner's local policy — `~/.pagespace/env-policy.json` →
 * `MachinePolicy | null` (Local Environments epic, invariants 4 and 5).
 *
 * `null` means deny-all, and it is the answer to everything that is not a
 * fully recognized, trustworthy file: missing, unreadable, not JSON, refused
 * by the strict parser (`parseMachinePolicy`, pure core) — AND a file that
 * is not owned by the user running the daemon or is writable by group/world.
 * The last two matter because the policy is the machine's whole gate: if any
 * local process could edit it, any local process could widen what the cloud
 * may run here. The file is checked with an injected `stat` so the rule is
 * tested against every case, not just the happy path.
 *
 * The loader also computes the digest the daemon advertises in `hello`
 * (`policyDigest`): SHA-256 of the file bytes when the policy is in force,
 * empty when it is not — the server records it, so an operator can tell which
 * policy a machine was running under. It is informational: the server never
 * sees the policy and can never change it.
 */
import { createHash } from 'node:crypto';
import { parseMachinePolicy, type MachinePolicy } from '@pagespace/lib/env-bridge/policy-types';

export const POLICY_FILE_NAME = 'env-policy.json';
export const POLICY_PATH_ENV_VAR = 'PAGESPACE_ENV_POLICY';

export type PolicyLoadReason = 'missing' | 'unreadable' | 'wrong_owner' | 'writable_by_others' | 'invalid_json' | 'invalid_schema';

export interface PolicyFileStat {
  readonly uid: number;
  /** The full st_mode; only the permission bits are inspected. */
  readonly mode: number;
}

export interface PolicyLoaderDeps {
  readonly path: string;
  /** The uid the daemon runs as; the file must be owned by it. */
  readonly uid: number;
  /** `null` when the file does not exist; may throw on any other error (fails closed as `unreadable`). */
  readonly stat: (path: string) => PolicyFileStat | null;
  readonly readFile: (path: string) => string;
}

export interface LoadedPolicy {
  readonly path: string;
  /** `null` ⇒ deny-all. */
  readonly policy: MachinePolicy | null;
  /** Why `policy` is null; `null` when it is not. */
  readonly reason: PolicyLoadReason | null;
  /** SHA-256 hex of the file bytes when a policy is in force; `''` otherwise. */
  readonly digest: string;
}

/** Group or world write bits. Read bits are fine: the policy is not a secret, only its integrity matters. */
const WRITABLE_BY_OTHERS_MASK = 0o022;

function refused(path: string, reason: PolicyLoadReason): LoadedPolicy {
  return { path, policy: null, reason, digest: '' };
}

export function loadMachinePolicy(deps: PolicyLoaderDeps): LoadedPolicy {
  const { path } = deps;
  let stat: PolicyFileStat | null;
  try {
    stat = deps.stat(path);
  } catch {
    return refused(path, 'unreadable');
  }
  if (stat === null) return refused(path, 'missing');
  if (stat.uid !== deps.uid) return refused(path, 'wrong_owner');
  if ((stat.mode & WRITABLE_BY_OTHERS_MASK) !== 0) return refused(path, 'writable_by_others');

  let raw: string;
  try {
    raw = deps.readFile(path);
  } catch {
    return refused(path, 'unreadable');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return refused(path, 'invalid_json');
  }
  const policy = parseMachinePolicy(parsed);
  if (policy === null) return refused(path, 'invalid_schema');
  return { path, policy, reason: null, digest: createHash('sha256').update(raw).digest('hex') };
}

/** `PAGESPACE_ENV_POLICY` wins; otherwise `~/.pagespace/env-policy.json`. */
export function defaultPolicyPath(env: Readonly<Record<string, string | undefined>>, homedir: string): string {
  const fromEnv = env[POLICY_PATH_ENV_VAR]?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : `${homedir}/.pagespace/${POLICY_FILE_NAME}`;
}

/** One line a human can act on. Printed at daemon start and by `env policy`. */
export function describePolicyRefusal(reason: PolicyLoadReason, path: string): string {
  switch (reason) {
    case 'missing':
      return `No policy file at ${path}: every request will be denied (no_policy). Create one to allow work on this machine — see "pagespace env policy".`;
    case 'unreadable':
      return `The policy file at ${path} could not be read: every request will be denied.`;
    case 'wrong_owner':
      return `The policy file at ${path} is owned by another user, so it is ignored (deny-all). Only a file owned by the user running the daemon is trusted.`;
    case 'writable_by_others':
      return `The policy file at ${path} is writable by group or world, so it is ignored (deny-all). Fix with: chmod 600 ${path}`;
    case 'invalid_json':
      return `The policy file at ${path} is not valid JSON, so it is ignored (deny-all).`;
    case 'invalid_schema':
      return `The policy file at ${path} is not a valid policy (unknown field, mode, op, or a non-absolute root), so it is ignored (deny-all).`;
  }
}
