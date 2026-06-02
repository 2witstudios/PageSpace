/**
 * Execution policy → sandbox create options (pure).
 *
 * Every sandbox is provisioned with explicit caps drawn from the resolved
 * `ExecutionPolicy` rather than the platform defaults (rule §5: "Explicit caps
 * from policy"). This mapper is the single translation point: it shapes the
 * policy's bounds into the option object the effect layer hands to the sandbox
 * client (`Sandbox.getOrCreate` / `create`). Keeping it pure and separate keeps
 * the create/resume effect free of policy knowledge.
 *
 * The option shape is declared locally rather than imported from a provider SDK:
 * the concrete sandbox client (Fly Sprites) and its create signature are injected
 * by the PR3 driver. This type is the contract the injected client must satisfy.
 */

import {
  SAFE_MINIMUM_PROFILE,
  type ExecutionPolicy,
} from './execution-policy';

export interface SandboxCreateOptions {
  /** Hard wall-clock cap for the sandbox, in milliseconds. */
  timeoutMs: number;
  /** vCPU allocation. */
  vcpus: number;
  /** Memory allocation, in megabytes. */
  memoryMb: number;
  /** Disk allocation, in gigabytes. An explicit per-sprite cap, not the quota default. */
  storageGb: number;
  /** Whether the sandbox survives between runs. Always false in v1. */
  persistent: boolean;
  /** Explicit deployment region. */
  region: string;
  /**
   * Egress firewall allowlist, carried through so the real client (PR3) can
   * translate it into the provider's network policy. Empty means default-deny
   * (no outbound). Frozen by the source policy.
   */
  egressAllowlist: readonly string[];
}

export function mapPolicyToSandboxOptions({
  policy = SAFE_MINIMUM_PROFILE,
}: { policy?: ExecutionPolicy } = {}): SandboxCreateOptions {
  return {
    timeoutMs: policy.timeoutMs,
    vcpus: policy.vcpus,
    memoryMb: policy.memoryMb,
    storageGb: policy.storageGb,
    persistent: policy.persistent,
    region: policy.region,
    egressAllowlist: policy.egressAllowlist,
  };
}
