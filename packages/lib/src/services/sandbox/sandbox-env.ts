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
 * with a module-not-found that named nothing to do with the env (#2466).
 *
 * `npm` specifically. Bun's installer ignores `NODE_ENV` for this and omits dev
 * dependencies only when told (`--production` / `--omit=dev`), which is why
 * nobody working in THIS repo ever tripped over it — the trap was waiting in the
 * npm-based repos agents clone into a sandbox. The
 * host's own mode is simply not a fact about the sandbox, so it is no longer
 * forwarded; nothing running INSIDE a sandbox reads `NODE_ENV` for our own
 * behaviour (every `NODE_ENV` branch in this repo — logging, cookies, checkpoint
 * policy, rate limits — evaluates on the host, never in a sandbox).
 *
 * This is every sandbox the product has, not only the throwaway ones: the same
 * builder feeds the bash tool, the git/gh tools, and the workspace runtime, so a
 * persistent DRIVE ENVIRONMENT gets it too — including one a user has named
 * "prod", since an environment's name is a label and nothing in the product ever
 * makes one a production deployment (see `drive-envs/env-contract.ts`). Uniform
 * on purpose: a second rule keyed on which kind of machine you are standing in
 * would recreate, one level down, exactly the "the same sandbox answers
 * differently depending on who asked" problem this change removes.
 *
 * It does of course reach OTHER people's code, which is the point and also the
 * cost: a cloned repo whose bundler keys off `NODE_ENV` (`mode: process.env
 * .NODE_ENV || 'production'` is everywhere) now produces a DEVELOPMENT build —
 * unminified, React in dev mode — where it used to produce a production one. That
 * is the right default for a machine whose whole job is to install a toolchain
 * and run tests, and it is recoverable per command (`NODE_ENV=production npm run
 * build`), whereas the failure it replaces was silent: an install that reported
 * success and left nothing to run.
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
 * The host env keys that are ELIGIBLE to be forwarded into a sandbox — reviewed,
 * one at a time, as non-secret and safe to hand to untrusted code.
 *
 * This union is the security decision, and it is deliberately a TYPE: the
 * allowlist below is typed by it, and so is the test seam on
 * {@link buildSandboxEnv}, so no caller anywhere — test, future refactor, or
 * mistake — can name `ENCRYPTION_KEY` or `DATABASE_URL` and have it compile. A
 * secret reaches a sandbox only by someone widening this union in a diff.
 */
type ForwardableEnvKey = Extract<keyof ServerEnv, 'NODE_ENV' | 'SENTRY_DSN' | 'WEB_APP_URL'>;

/**
 * Host env keys actually forwarded verbatim into a sandbox.
 *
 * Deliberately EMPTY: no property of the host process is currently a fact the
 * sandbox needs (`NODE_ENV` was the last one, and it was actively wrong — see
 * {@link SANDBOX_BASE_ENV}). The forwarding machinery is kept because the
 * allowlist, not its current contents, is the security invariant: a future
 * non-secret key is added here explicitly, and everything else stays excluded by
 * construction.
 */
const SANDBOX_ENV_ALLOWLIST: readonly ForwardableEnvKey[] = [];

/**
 * @param allowlist Injected ONLY so the forwarding rule stays testable while the
 * production allowlist is empty. With nothing to forward, a test against the
 * real allowlist proves nothing — every "this secret does not reach the sandbox"
 * assertion passes vacuously, and deleting the loop outright would keep the
 * suite green — so the tests hand in a fixture allowlist and check the rule that
 * will matter the day a key is added back: allowlisted keys pass, everything
 * else stays out, and a sandbox-owned value still wins. Production never passes
 * it, and {@link ForwardableEnvKey} means it could not be abused to forward a
 * secret if it did.
 */
export function buildSandboxEnv({
  env,
  allowlist = SANDBOX_ENV_ALLOWLIST,
}: { env: Partial<ServerEnv>; allowlist?: readonly ForwardableEnvKey[] }): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const key of allowlist) {
    const value = env[key];
    if (typeof value === 'string') {
      forwarded[key] = value;
    }
  }
  // Sandbox-owned values are applied LAST so a forwarded host key can never
  // shadow one — the sandbox's own identity is not the host's to overwrite.
  return { ...forwarded, ...SANDBOX_BASE_ENV };
}
