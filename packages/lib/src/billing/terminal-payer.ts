/**
 * resolveTerminalPayerId — the ONE seam that names who pays for a Machine's
 * active runtime.
 *
 * Default: the drive owner. Every sandbox acquisition path (agent tool runs via
 * `createResolveSandboxActorContext`, interactive PTY sessions via
 * `makeTerminalCheckAuth`) already resolves `tenantId` to `drive.ownerId` before
 * a machine is ever acquired, so the drive owner is the payer by construction
 * today. Kept as a single named function — not inlined at each call site — so
 * Terminal Epic 3's future owner-pays node (a configurable billing owner,
 * distinct from the drive owner) can swap this in ONE place.
 */
export interface ResolveTerminalPayerInput {
  /** The drive-owning account, as resolved by every current machine-acquisition path. */
  tenantId: string;
}

export function resolveTerminalPayerId(input: ResolveTerminalPayerInput): string {
  return input.tenantId;
}
