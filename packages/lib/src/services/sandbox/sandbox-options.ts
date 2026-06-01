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
 * The option shape is declared locally rather than imported from
 * `@vercel/sandbox`: PR2 owns no execution path, so the concrete client (and its
 * exact create signature) is injected by later PRs. This type is the contract
 * the injected client must satisfy.
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
  /** Whether the sandbox survives between runs. Always false in v1. */
  persistent: boolean;
  /** Explicit deployment region. */
  region: string;
}

export function mapPolicyToSandboxOptions({
  policy = SAFE_MINIMUM_PROFILE,
}: { policy?: ExecutionPolicy } = {}): SandboxCreateOptions {
  return {
    timeoutMs: policy.timeoutMs,
    vcpus: policy.vcpus,
    memoryMb: policy.memoryMb,
    persistent: policy.persistent,
    region: policy.region,
  };
}
