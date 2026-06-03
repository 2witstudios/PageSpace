/**
 * Sandbox environment construction (pure).
 *
 * The sandbox runs untrusted, agent-generated code. It must receive NO host
 * secrets: no DB credentials, no session tokens, no API keys, no signing
 * secrets. We build the sandbox env by *allowlist* — copying only a fixed set
 * of explicitly-safe keys — and never spread `process.env` or the validated env
 * wholesale. Any outbound capability the sandbox needs is provided later via
 * Vercel credential brokering, never as a raw secret in the environment.
 *
 * Building by allowlist (rather than denylist) is the provable construction:
 * a newly-added secret is excluded by default unless someone deliberately adds
 * its key here — which the review gate would catch.
 *
 * Pure by construction: the validated env is INJECTED, never read from a global
 * here. The production wiring (`defaultBuildEnv` in `tool-runners`) sources it
 * from `getValidatedEnv()`; this function reads no globals and never throws, so
 * it is deterministic and trivially testable.
 */

import type { ServerEnv } from '../../config/env-validation';

/**
 * The only keys ever forwarded into a sandbox. Each must be non-secret and
 * safe to expose to untrusted code. Adding a key here is a security decision.
 */
const SANDBOX_ENV_ALLOWLIST = ['NODE_ENV'] as const;

type AllowlistedKey = (typeof SANDBOX_ENV_ALLOWLIST)[number];

export function buildSandboxEnv({
  env,
}: { env: Partial<ServerEnv> }): Record<AllowlistedKey, string> {
  const result = {} as Record<AllowlistedKey, string>;
  for (const key of SANDBOX_ENV_ALLOWLIST) {
    const value = env[key];
    if (typeof value === 'string') {
      result[key] = value;
    }
  }
  return result;
}
