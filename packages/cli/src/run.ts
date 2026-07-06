/**
 * run() — the composition root. Takes argv/env/stdout/stderr/credentialStore
 * as plain injected values (no `process.*` reference anywhere in this file)
 * and returns an exit code; `bin.ts` is the only caller that touches the
 * real process.
 */
import { PageSpaceClient } from '@pagespace/sdk';
import { parseArgv } from './argv/parse.js';
import { buildAuthProvider, enforceAuth } from './auth/auth-context.js';
import { createDiscoverMetadata } from './auth/discover.js';
import { resolveEnvToken } from './auth/legacy-token-env.js';
import { createRefreshAccessToken } from './auth/silent-refresh.js';
import { hasExplicitCredential, noExplicitCredentialMessage, resolveAuth, resolveProfileName } from './auth/resolve.js';
import { loginHandler } from './commands/login.js';
import { loginDeviceHandler } from './commands/login-device.js';
import { logoutHandler } from './commands/logout.js';
import { tokensCreateHandler } from './commands/tokens/create.js';
import { keysListHandler, keysRevokeHandler } from './commands/keys/aliases.js';
import { keysHandler } from './commands/keys/wizard.js';
import { versionHandler } from './commands/version.js';
import { whoamiHandler } from './commands/whoami.js';
import { resolveConfig } from './config/resolve.js';
import type { CredentialStore } from './credentials/store.js';
import { EXIT_RUNTIME_ERROR, EXIT_USAGE_ERROR, type ExitCode } from './exit-codes.js';
import type { HandlerContext, OutputSink } from './handler-context.js';
import { resolveRoute } from './router/router.js';
import { helpHandler, ROUTES } from './router/routes.js';

export interface RunDependencies {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: OutputSink;
  readonly stderr: OutputSink;
  readonly credentialStore: CredentialStore;
  /** Defaults to `false` (fail-closed) when omitted — only `bin.ts` knows the real terminal state. */
  readonly isTTY?: boolean;
  /** Defaults to a function that never resolves truthily when omitted; only called when `isTTY` is true. */
  readonly prompt?: (message: string) => Promise<string>;
}

/**
 * Commands that manage credentials themselves and never touch `ctx.sdk`'s
 * ambient-resolved auth source at all: `help` doesn't need auth; `login`/
 * `login --device` establish a credential from scratch; `logout`/`whoami`
 * construct their own `CredentialStore` and do their own discovery/refresh
 * (matching `login.ts`'s sanctioned pattern) because "not logged in" is a
 * normal, graceful outcome for them, not a hard failure. `tokens create`
 * belongs here for the same reason `login` does: it mints its credential
 * through its own browser-consent OAuth flow (Phase 8 task 2) and never
 * touches `ctx.sdk` either.
 *
 * This set gates BOTH checks below — the ambient-credential-fallback gate
 * (first) and `enforceAuth` (second) — for the handlers above, since neither
 * check's subject (the `source`/`auth` built from `resolveAuth`'s flag > env
 * > stored-profile precedence) is ever consulted by them. Every OTHER
 * handler, including `mcp`, DOES eventually authenticate through `ctx.sdk`
 * when given a credential, so both checks matter there: the ambient gate
 * refuses to even attempt that authentication on nothing but a stored
 * default/personal profile (originally Phase 8 task 4's `mcp`-only gate,
 * generalized here in Phase 9 task 4 to every command — a coding agent with
 * shell access must never be able to ride a human's `pagespace login`
 * credential into content access), and `enforceAuth` is what actually
 * materializes and validates whichever explicit source WAS given.
 *
 * Phase 9 task 5's `pagespace keys` TUI (`keysHandler`) belongs here for the
 * same reason: like `login`/`tokens create`, it's the whole point of a bare
 * `pagespace login`'s ambient `manage_keys`-scoped credential — it lists,
 * mints (via the same browser-consent flow `tokens create` uses), and
 * revokes keys through `ctx.sdk` itself, with zero extra setup. `keysListHandler`/
 * `keysRevokeHandler` (`commands/keys/aliases.ts`) are exempted alongside it
 * for the identical reason — but note they are DISTINCT handler references
 * from `tokensListHandler`/`tokensRevokeHandler`, specifically so exempting
 * the `keys` surface does not also exempt `tokens list`/`tokens revoke`,
 * which stay explicit-credential-only (see `router/routes.ts`'s `keys` vs
 * `tokens` design note). `keys create` needs no separate entry: it registers
 * the exact same `tokensCreateHandler` reference already listed below.
 */
const AUTH_EXEMPT_HANDLERS = new Set([
  helpHandler,
  loginHandler,
  logoutHandler,
  whoamiHandler,
  tokensCreateHandler,
  keysHandler,
  keysListHandler,
  keysRevokeHandler,
]);

export async function run(deps: RunDependencies): Promise<ExitCode> {
  const parsed = parseArgv(deps.argv);
  if (parsed.kind === 'usage-error') {
    deps.stderr.write(`${parsed.message}\n`);
    return EXIT_USAGE_ERROR;
  }

  const { host } = resolveConfig({
    flags: { host: parsed.flags.host },
    env: { PAGESPACE_API_URL: deps.env.PAGESPACE_API_URL },
    profile: null,
  });

  const envToken = resolveEnvToken(deps.env);
  if (envToken.deprecationNotice) {
    deps.stderr.write(`${envToken.deprecationNotice}\n`);
  }

  const profileName = resolveProfileName({ profile: parsed.flags.profile }, { PAGESPACE_PROFILE: deps.env.PAGESPACE_PROFILE });
  const credential = await deps.credentialStore.get(host, profileName);
  const source = resolveAuth(
    { token: parsed.flags.token },
    { PAGESPACE_TOKEN: envToken.token },
    credential ? { [host]: { [profileName]: credential } } : {},
    host,
    profileName,
  );

  const auth = buildAuthProvider(source, {
    discoverMetadata: createDiscoverMetadata(),
    createRefreshAccessToken,
    credentialStore: deps.credentialStore,
    now: Date.now,
  });

  const ctx: HandlerContext = {
    sdk: new PageSpaceClient({ baseUrl: host, auth }),
    stdout: deps.stdout,
    stderr: deps.stderr,
    env: deps.env,
    credentialStore: deps.credentialStore,
    isTTY: deps.isTTY ?? false,
    prompt: deps.prompt ?? (async () => ''),
  };

  if (parsed.flags.version) {
    return versionHandler(ctx, parsed);
  }
  if (parsed.flags.help && parsed.args.length === 0) {
    return helpHandler(ctx, parsed);
  }
  if (parsed.args.length === 1 && parsed.args[0] === 'login' && parsed.flags.device) {
    return loginDeviceHandler(ctx, parsed);
  }

  const resolution = resolveRoute(ROUTES, parsed.args);
  if (resolution.kind === 'usage-error') {
    deps.stderr.write(`${resolution.message}\n`);
    return EXIT_USAGE_ERROR;
  }

  const isAuthExempt = AUTH_EXEMPT_HANDLERS.has(resolution.route.handler);

  if (!isAuthExempt && !hasExplicitCredential({ token: parsed.flags.token, profile: parsed.flags.profile }, deps.env)) {
    // Must run before `enforceAuth` below: that call materializes `source` by
    // calling `auth.getAccessToken()`, which for a `kind: 'profile'` source
    // (the ambient "default"/personal profile falling through here with
    // nothing explicit given) performs a real discovery + refresh-token
    // network exchange and rotates the stored personal credential — exactly
    // the fallback this gate exists to block, for every command that isn't
    // exempt above (Phase 8 task 4, generalized in Phase 9 task 4). Checking
    // first means that network/store effect never happens at all, not just
    // that the command never runs afterward.
    deps.stderr.write(`${noExplicitCredentialMessage()}\n`);
    return EXIT_RUNTIME_ERROR;
  }

  if (!isAuthExempt) {
    const failure = await enforceAuth({ auth, source, credentialStore: deps.credentialStore, stderr: deps.stderr });
    if (failure !== null) {
      return failure;
    }
  }

  return resolution.route.handler(ctx, { ...parsed, args: resolution.rest });
}
