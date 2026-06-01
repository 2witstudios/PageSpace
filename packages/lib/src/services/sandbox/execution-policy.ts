/**
 * Execution policy resolution (pure).
 *
 * Every sandbox run is bounded by an explicit policy — timeout, vCPU, memory,
 * output cap, egress allowlist, persistence, region — rather than inheriting
 * platform defaults. Egress is default-deny (empty allowlist) and sandboxes are
 * ephemeral (`persistent: false`) on every profile in v1; an allowlist is only
 * ever populated by a deliberate future change, never by omission.
 *
 * An unrecognized profile resolves to the safe minimum — the most restrictive
 * policy — so a typo or an unknown caller can never widen the blast radius.
 */

export type ExecutionProfile = 'default' | 'minimal';

export interface ExecutionPolicy {
  /** Profile this policy represents (echoed back for audit/logging). */
  profile: ExecutionProfile;
  /** Hard wall-clock cap for a single run, in milliseconds. */
  timeoutMs: number;
  /** vCPU allocation. */
  vcpus: number;
  /** Memory allocation, in megabytes. */
  memoryMb: number;
  /** Maximum stdout/stderr bytes retained before truncation. */
  maxOutputBytes: number;
  /** Egress firewall allowlist. Empty means default-deny (no outbound). */
  egressAllowlist: readonly string[];
  /** Whether the sandbox survives between runs. Always false in v1. */
  persistent: boolean;
  /** Explicit deployment region. */
  region: string;
}

// Policies are returned by reference from module constants. Freeze them (and
// their egress arrays) so a downstream caller can never mutate the shared
// default-deny baseline — e.g. `policy.egressAllowlist.push(host)` would
// otherwise widen egress globally for every subsequent run. Frozen → it throws.

/**
 * Most-restrictive policy. Also the fallback for any unknown profile.
 */
export const SAFE_MINIMUM_PROFILE: ExecutionPolicy = Object.freeze({
  profile: 'minimal',
  timeoutMs: 10_000,
  vcpus: 1,
  memoryMb: 512,
  maxOutputBytes: 32 * 1024,
  egressAllowlist: Object.freeze([]) as readonly string[],
  persistent: false,
  region: 'iad1',
});

const DEFAULT_PROFILE: ExecutionPolicy = Object.freeze({
  profile: 'default',
  timeoutMs: 30_000,
  vcpus: 1,
  memoryMb: 1024,
  maxOutputBytes: 64 * 1024,
  egressAllowlist: Object.freeze([]) as readonly string[],
  persistent: false,
  region: 'iad1',
});

const PROFILES: Record<ExecutionProfile, ExecutionPolicy> = {
  default: DEFAULT_PROFILE,
  minimal: SAFE_MINIMUM_PROFILE,
};

export function resolveExecutionPolicy({
  profile = 'default',
}: { profile?: string } = {}): ExecutionPolicy {
  // Own-key check, not `PROFILES[profile] ?? ...`: a bracket lookup resolves
  // inherited keys, so a profile of '__proto__' / 'constructor' / 'toString'
  // would return a truthy prototype member and skip the safe-minimum fallback —
  // yielding an object with no policy bounds. Only own keys are real profiles.
  return Object.prototype.hasOwnProperty.call(PROFILES, profile)
    ? PROFILES[profile as ExecutionProfile]
    : SAFE_MINIMUM_PROFILE;
}
