/**
 * Policy types for the zero-trust bridge, and the untrusting parser for the
 * daemon's local policy file (epic "Local Environments — zero-trust bridge",
 * invariants 4 and 5).
 *
 * Three inputs decide whether a granted request may run on the user's machine:
 *
 * - `AdvertisedCapabilities` — what the machine CAN do (sent in `hello`).
 * - `ServerPolicy`           — what the drive's `drive_env_local.serverPolicy`
 *                              allows for this env (deny-by-default).
 * - `MachinePolicy`          — what the machine OWNER allows, from a local
 *                              policy file the server never sees or edits.
 *
 * Effective permission is their intersection; see `decide-execution.ts`.
 *
 * `parseMachinePolicy` is deliberately strict and returns `null` — never a
 * partial policy, never a default-permissive one — for anything it does not
 * fully recognize. A daemon with `null` policy denies everything (invariant 5:
 * a missing or unparseable policy is deny-all).
 */
import { z } from 'zod';
import { GRANT_OPS, type GrantOp } from './grant';

export const POLICY_MODES = ['ask', 'allowlist', 'deny'] as const;
export type PolicyMode = (typeof POLICY_MODES)[number];

/** Output cap applied when the policy file does not set one. */
export const DEFAULT_MAX_BYTES = 1_048_576;
/** Per-command wall-clock cap applied when the policy file does not set one. */
export const DEFAULT_MAX_TIMEOUT_MS = 120_000;

/** Shape shared by the server-side and machine-side allow sets. */
export interface AllowedOperations {
  readonly ops: readonly GrantOp[];
  /** Whether filesystem checkpoints are supported/allowed. Never true by default. */
  readonly checkpoint: boolean;
}

export interface MachinePolicy {
  /**
   * `ask`       — ops listed in `ops` run without prompting; anything else prompts.
   * `allowlist` — only ops listed in `ops` run; anything else is denied.
   * `deny`      — nothing runs.
   */
  readonly mode: PolicyMode;
  /** User ids the machine owner allows to drive this machine. */
  readonly principals: readonly string[];
  readonly ops: readonly GrantOp[];
  /** Absolute directories every cwd and path must resolve inside. */
  readonly roots: readonly string[];
  /** Environment variable NAMES the server may set (loader hooks are always refused). */
  readonly envAllowlist: readonly string[];
  readonly maxBytes: number;
  readonly maxTimeoutMs: number;
}

export type ServerPolicy = AllowedOperations;

export interface AdvertisedCapabilities {
  readonly shell: boolean;
  readonly pty: boolean;
  readonly fs: boolean;
  readonly checkpoint: boolean;
}

export type EffectiveCapabilities = Readonly<Record<GrantOp, boolean>> & { readonly checkpoint: boolean };

/** POSIX environment variable name. Anything else cannot be set safely. */
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const machinePolicySchema = z
  .object({
    mode: z.enum(POLICY_MODES),
    principals: z.array(z.string().min(1)),
    ops: z.array(z.enum(GRANT_OPS)),
    // A root must be absolute, must not be `/` (confinement would be vacuous),
    // and must not contain `..` (the lexical layer refuses `..` in requests, so
    // a root spelled with one could never be matched consistently).
    roots: z.array(
      z
        .string()
        .min(1)
        .refine((root) => root.startsWith('/'), 'root must be absolute')
        .refine((root) => root.replace(/\/+$/, '') !== '', 'root must not be the filesystem root')
        .refine((root) => !root.split('/').includes('..'), 'root must not contain .. segments'),
    ),
    envAllowlist: z.array(z.string().regex(ENV_NAME_RE)),
    maxBytes: z.number().int().positive().default(DEFAULT_MAX_BYTES),
    maxTimeoutMs: z.number().int().positive().default(DEFAULT_MAX_TIMEOUT_MS),
  })
  .strict();

/**
 * Parse a policy file's contents. `null` for anything not fully recognized —
 * an unknown mode, an op outside the closed union, a relative root, an extra
 * field — so a typo can only ever make the machine MORE restrictive.
 */
export function parseMachinePolicy(input: unknown): MachinePolicy | null {
  const parsed = machinePolicySchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}
