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
import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync } from 'node:fs';
import { parseMachinePolicy, type MachinePolicy } from './lib-core.js';

export const POLICY_FILE_NAME = 'env-policy.json';
export const POLICY_PATH_ENV_VAR = 'PAGESPACE_ENV_POLICY';

export type PolicyLoadReason = 'missing' | 'unreadable' | 'wrong_owner' | 'writable_by_others' | 'invalid_json' | 'invalid_schema';

/** Owner, permission bits and content, ALL read from the SAME descriptor (CWE-367: no stat-then-read on the pathname). */
export interface OpenedPolicyFile {
  readonly uid: number;
  /** The full st_mode; only the permission bits are inspected. */
  readonly mode: number;
  readonly content: string;
}

export interface PolicyLoaderDeps {
  readonly path: string;
  /** The uid the daemon runs as; the file must be owned by it. */
  readonly uid: number;
  /** Open the file ONCE and return its fstat identity and content together; `null` when it does not exist; may throw (fails closed as `unreadable`). */
  readonly open: (path: string) => OpenedPolicyFile | null;
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
  let opened: OpenedPolicyFile | null;
  try {
    opened = deps.open(path);
  } catch {
    // ENOENT surfaces as null; any other open/fstat/read error fails closed.
    return refused(path, 'unreadable');
  }
  if (opened === null) return refused(path, 'missing');
  if (opened.uid !== deps.uid) return refused(path, 'wrong_owner');
  if ((opened.mode & WRITABLE_BY_OTHERS_MASK) !== 0) return refused(path, 'writable_by_others');

  let parsed: unknown;
  try {
    parsed = JSON.parse(opened.content);
  } catch {
    return refused(path, 'invalid_json');
  }
  const policy = parseMachinePolicy(parsed);
  if (policy === null) return refused(path, 'invalid_schema');
  return { path, policy, reason: null, digest: createHash('sha256').update(opened.content).digest('hex') };
}

/**
 * The production adapter: open the policy path ONCE with `O_NOFOLLOW` (a
 * symlink where the policy should be is refused, not followed), then read
 * ownership, mode and content from that one descriptor via `fstat` + read.
 * A local attacker who renames entries in the directory cannot swap the file
 * between a check and a read, because there is no second lookup by name
 * (CWE-367). `null` only for ENOENT; everything else throws (fail closed).
 */
export function openPolicyFile(path: string): OpenedPolicyFile | null {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    return { uid: stat.uid, mode: stat.mode, content: readFileSync(fd, 'utf8') };
  } finally {
    closeSync(fd);
  }
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
