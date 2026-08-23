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
 * The sandbox's OWN environment — values the sandbox defines for itself, with no
 * dependence on how the host web server happens to be running.
 *
 * `NODE_ENV=development`: a sandbox is a development machine. An agent clones a
 * repo, installs its toolchain, and runs its tests there; nothing inside a
 * sandbox is ever a production deployment of anything. This used to be forwarded
 * from the host instead (the allowlist below carried `NODE_ENV`), which meant a
 * sandbox opened from our production web server reported `NODE_ENV=production` —
 * and npm silently drops `devDependencies` under that, so a plain
 * `npm install` left `tsx`/`vitest`/`tsc` missing and every later command failed
 * with a module-not-found that named nothing to do with the env (#2466). The
 * host's own mode is simply not a fact about the sandbox, so it is no longer
 * forwarded; nothing running INSIDE a sandbox reads `NODE_ENV` for our own
 * behaviour (every `NODE_ENV` branch in this repo — logging, cookies, checkpoint
 * policy, rate limits — evaluates on the host, never in a sandbox).
 *
 * `PYTHONUNBUFFERED=1`: CPython block-buffers stdout when it is a pipe rather
 * than a tty, so a long python job behind a filter (`… | grep -v noise`) shows
 * NOTHING in the terminal pane until it exits (#2468). It is set HERE, rather
 * than left to the caller, because python is the one case the documented
 * workaround cannot reach: `stdbuf` retunes libc's stdio buffers, and CPython
 * buffers in its own io layer ABOVE libc, so `stdbuf -oL python3 …` changes
 * nothing (measured against a live sandbox — see the PR). Every other common
 * producer is already reachable: `stdbuf -oL` for C/stdio programs, nothing
 * needed for node. The `spawn_shell`/`send_shell`/`read_shell` descriptions carry
 * that guidance for the stages this variable cannot cover.
 *
 * These are sandbox-owned: a forwarded host key can never override one.
 */
export const SANDBOX_BASE_ENV = {
  NODE_ENV: 'development',
  PYTHONUNBUFFERED: '1',
} as const satisfies Record<string, string>;

/**
 * Host env keys forwarded verbatim into a sandbox. Each must be non-secret and
 * safe to expose to untrusted code. Adding a key here is a security decision.
 *
 * Deliberately EMPTY: no property of the host process is currently a fact the
 * sandbox needs (`NODE_ENV` was the last one, and it was actively wrong — see
 * {@link SANDBOX_BASE_ENV}). The forwarding machinery is kept because the
 * allowlist, not its current contents, is the security invariant: a future
 * non-secret key is added here explicitly, and everything else stays excluded by
 * construction.
 */
const SANDBOX_ENV_ALLOWLIST: readonly (keyof ServerEnv)[] = [];

export function buildSandboxEnv({
  env,
}: { env: Partial<ServerEnv> }): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const key of SANDBOX_ENV_ALLOWLIST) {
    const value = env[key];
    if (typeof value === 'string') {
      forwarded[key] = value;
    }
  }
  // Sandbox-owned values are applied LAST so a forwarded host key can never
  // shadow one — the sandbox's own identity is not the host's to overwrite.
  return { ...forwarded, ...SANDBOX_BASE_ENV };
}
