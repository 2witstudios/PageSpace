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
import { mcpHandler } from './commands/mcp.js';
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
 * Commands that manage credentials themselves and never touch `ctx.sdk`:
 * `help` doesn't need auth; `login`/`login --device` establish it; `logout`/
 * `whoami` construct their own `CredentialStore` and do their own
 * discovery/refresh (matching `login.ts`'s sanctioned pattern) because
 * "not logged in" is a normal, graceful outcome for them, not a hard
 * failure — routing them through `enforceAuth` first would print this
 * resolver's generic message (and attempt a redundant refresh) ahead of
 * their own, more specific handling. `mcp` is NOT in this set: when given an
 * explicit credential it authenticates through `ctx.sdk` exactly like every
 * other command below. But it can't be blanket-exempted either, so it gets
 * its own pre-`enforceAuth` gate just below — without it, `enforceAuth`
 * would materialize (and, on a stored default profile, silently refresh and
 * rotate) the ambient personal credential before `mcp`'s own fail-closed
 * check ever ran (Phase 8 task 4).
 */
const AUTH_EXEMPT_HANDLERS = new Set([helpHandler, loginHandler, logoutHandler, whoamiHandler]);

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

  if (
    resolution.route.handler === mcpHandler &&
    !hasExplicitCredential({ token: parsed.flags.token, profile: parsed.flags.profile }, deps.env)
  ) {
    // Must run before `enforceAuth` below: that call materializes `source` by
    // calling `auth.getAccessToken()`, which for a `kind: 'profile'` source
    // (the ambient "default" profile falling through here with nothing
    // explicit given) performs a real discovery + refresh-token network
    // exchange and rotates the stored personal credential — exactly the
    // fallback this gate exists to block. Checking first means that
    // network/store effect never happens at all, not just that the server
    // never starts afterward.
    deps.stderr.write(`${noExplicitCredentialMessage()}\n`);
    return EXIT_RUNTIME_ERROR;
  }

  if (!AUTH_EXEMPT_HANDLERS.has(resolution.route.handler)) {
    const failure = await enforceAuth({ auth, source, credentialStore: deps.credentialStore, stderr: deps.stderr });
    if (failure !== null) {
      return failure;
    }
  }

  return resolution.route.handler(ctx, { ...parsed, args: resolution.rest });
}
