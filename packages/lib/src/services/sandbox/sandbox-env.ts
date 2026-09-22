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
import { signInEnvFor } from '../drive-envs/env-oauth-client';

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
 *
 * Do NOT add `TERM`, `COLORTERM` or `LANG` here. Those belong to the interactive
 * terminal, which layers them AFTER this base (`terminalEnv` in
 * `apps/realtime/.../sprites-shell.ts`) — so adding one here to make the two
 * surfaces agree would achieve the opposite: the batch tool would take it and the
 * terminal would keep overriding it, silently.
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
 * Which environment (if any) the sandbox belongs to — the ONE fact "Sign in
 * with PageSpace" needs from the caller (ADR 0004 Decision 12, US6).
 *
 * A drive environment hosts an app, and that app signs users in through the
 * platform-managed OAuth client `env_<envId>` (`drive-envs/env-oauth-client.ts`).
 * The sandbox is told so through two PUBLIC values: `PAGESPACE_URL` (the host
 * app's origin, read from the validated `WEB_APP_URL`) and
 * `PAGESPACE_CLIENT_ID`. Neither is a credential — a public client
 * authenticates with PKCE, never with an id — which is the whole reason they
 * may cross this boundary at all; the secret-shape guard below
 * ({@link findSecretShapedEnvEntries}) is what keeps that sentence true as the
 * map grows. An ephemeral SESSION sandbox has no env and therefore no client:
 * it gets the URL only, and `PageSpaceClient.fromEnvironment()` names the
 * missing variable rather than signing in as nobody.
 */
export interface SandboxSignInTarget {
  envId: string | null;
}

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
 * The forwarding rule, with the allowlist as a parameter.
 *
 * Exported for TESTS ONLY, and named so that a production caller reaching for it
 * reads as the deviation it would be. It exists because the production allowlist
 * is empty: a test against that allowlist proves nothing — every "this secret
 * does not reach the sandbox" assertion passes vacuously, and deleting the loop
 * outright would keep the suite green — so the tests hand in a fixture allowlist
 * and check the rule that will matter the day a key is added back.
 *
 * {@link buildSandboxEnv} keeps the narrow signature deliberately: the security
 * boundary every production seam calls cannot be handed an allowlist at all, so
 * the module docblock's invariant holds structurally — what a sandbox may receive
 * changes only by editing THIS file, under review.
 *
 * @internal
 */
export function composeSandboxEnvForTest(
  env: Partial<ServerEnv>,
  allowlist: readonly ForwardableEnvKey[],
  signIn?: SandboxSignInTarget,
): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const key of allowlist) {
    const value = env[key];
    if (typeof value === 'string') {
      forwarded[key] = value;
    }
  }
  // The sign-in values are DERIVED (from the env id and the validated app
  // URL), never forwarded: `signInEnvFor` is the single source both this map
  // and the published machine's env read from, so the two cannot spell them
  // differently. Sandbox-owned values are applied LAST so neither a forwarded
  // host key nor a derived value can ever shadow one — the sandbox's own
  // identity is not the host's to overwrite.
  const signInValues = signInEnvFor({ envId: signIn?.envId ?? null, pagespaceUrl: env.WEB_APP_URL });
  return { ...forwarded, ...signInValues, ...SANDBOX_BASE_ENV };
}

export function buildSandboxEnv({ env, signIn }: { env: Partial<ServerEnv>; signIn?: SandboxSignInTarget }): Record<string, string> {
  return composeSandboxEnvForTest(env, SANDBOX_ENV_ALLOWLIST, signIn);
}

/** Why an entry looks like a secret: its value carries a known credential prefix, or its key is named like one. */
export interface SecretShapedEnvEntry {
  key: string;
  reason: 'value_prefix' | 'key_suffix';
}

/**
 * Credential prefixes this platform mints or stores: `mcp_` (MCP keys),
 * `ps_` (OAuth `ps_at_`/`ps_rt_`, session `ps_sess_`), `sk_` (provider API
 * keys). Case-insensitive, checked on the VALUE.
 */
const SECRET_VALUE_PREFIX_RE = /^(mcp_|ps_|sk_)/i;

/** Key names that by convention hold credentials. Case-insensitive, checked on the KEY. */
const SECRET_KEY_SUFFIX_RE = /_(TOKEN|SECRET|KEY)$/i;

/**
 * Pure: every entry of an env map that LOOKS like a secret, by shape alone —
 * the tripwire the sandbox and the published-machine env maps are both held
 * to in their tests. A public client id (`env_<id>`) matches neither rule and
 * is exactly the value this guard exists to distinguish from a credential.
 *
 * Shape is all it can see: a secret under an innocent key with an unknown
 * prefix passes. That is the allowlist construction's job (nothing reaches the
 * map without a reviewed key); this is the second line, for the values the
 * platform DERIVES rather than forwards.
 */
export function findSecretShapedEnvEntries(env: Readonly<Record<string, string>>): SecretShapedEnvEntry[] {
  const found: SecretShapedEnvEntry[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (SECRET_VALUE_PREFIX_RE.test(value)) found.push({ key, reason: 'value_prefix' });
    else if (SECRET_KEY_SUFFIX_RE.test(key)) found.push({ key, reason: 'key_suffix' });
  }
  return found;
}

/**
 * A tripwire, not a behaviour test: it fails the moment someone forwards a host
 * key, and its message is the handshake that fact requires.
 *
 * Forwarding is a two-service decision. The `bash`/`git` tools build their env
 * from the WEB service's validated env; the interactive terminal builds it from
 * the REALTIME service's raw `process.env` (that service cannot validate — see
 * `sprites-shell.ts`). So a key that only one deployment sets, or that only one
 * side validates, puts the two surfaces back to answering `env | grep X`
 * differently — which is exactly the bug (#2466) this file exists to have fixed.
 * Nothing else in the tree fails when that happens, so this does.
 */
export const SANDBOX_ENV_ALLOWLIST_TRIPWIRE = SANDBOX_ENV_ALLOWLIST;
