/** Provider-neutral resource caps for a sandbox VM. Mapped to the backing
 *  provider's config by the driver (e.g. Sprites' `SpriteConfig`). All optional:
 *  an unset field falls back to the provider default. */
export interface SandboxResourceCaps {
  /** RAM in megabytes. */
  ramMB?: number;
  /** Number of vCPUs. */
  cpus?: number;
  /** Persistent storage in gigabytes. */
  storageGB?: number;
  /** Region hint (provider-specific code, e.g. a Fly region). */
  region?: string;
}

export interface SandboxCreateOptions {
  egressAllowlist: readonly string[];
  /** Resource caps applied at creation; omitted → provider defaults. */
  caps?: SandboxResourceCaps;
}

/**
 * Why a provisioning attempt failed, normalized across providers so the neutral
 * lifecycle layer can react (and surface a distinct reason) without importing the
 * backing SDK's error types:
 *  - `rate_limited` — creation/concurrent rate limit; honor `retryAfterSeconds`.
 *  - `conflict` — name/state conflict (e.g. a delete-then-recreate race).
 *  - `unavailable` — any other infrastructure failure.
 */
export type SandboxProvisionFailureKind = 'rate_limited' | 'conflict' | 'unavailable';

/** Classified provisioning failure thrown by a sandbox driver's `getOrCreate`. */
export class SandboxProvisionError extends Error {
  constructor(
    public readonly kind: SandboxProvisionFailureKind,
    public readonly retryAfterSeconds: number | undefined,
    public readonly providerCause: unknown,
  ) {
    super(`Sandbox provisioning failed: ${kind}`);
    this.name = 'SandboxProvisionError';
  }
}
