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
import { createRefreshAccessToken } from './auth/silent-refresh.js';
import { resolveAuth } from './auth/resolve.js';
import { helpHandler } from './commands/help.js';
import { loginHandler } from './commands/login.js';
import { loginDeviceHandler } from './commands/login-device.js';
import { logoutHandler } from './commands/logout.js';
import { versionHandler } from './commands/version.js';
import { whoamiHandler } from './commands/whoami.js';
import { resolveConfig } from './config/resolve.js';
import type { CredentialStore } from './credentials/store.js';
import { EXIT_USAGE_ERROR, type ExitCode } from './exit-codes.js';
import type { HandlerContext, OutputSink } from './handler-context.js';
import { resolveRoute, type Route } from './router/router.js';

export interface RunDependencies {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: OutputSink;
  readonly stderr: OutputSink;
  readonly credentialStore: CredentialStore;
}

const ROUTES: readonly Route[] = [
  { path: ['help'], handler: helpHandler },
  { path: ['login'], handler: loginHandler },
  { path: ['logout'], handler: logoutHandler },
  { path: ['whoami'], handler: whoamiHandler },
];

/**
 * Commands that manage credentials themselves and never touch `ctx.sdk`:
 * `help` doesn't need auth; `login`/`login --device` establish it; `logout`/
 * `whoami` construct their own `CredentialStore` and do their own
 * discovery/refresh (matching `login.ts`'s sanctioned pattern) because
 * "not logged in" is a normal, graceful outcome for them, not a hard
 * failure — routing them through `enforceAuth` first would print this
 * resolver's generic message (and attempt a redundant refresh) ahead of
 * their own, more specific handling.
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

  const credential = await deps.credentialStore.get(host);
  const source = resolveAuth(
    { token: parsed.flags.token },
    { PAGESPACE_TOKEN: deps.env.PAGESPACE_TOKEN },
    credential ? { [host]: credential } : {},
    host,
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

  if (!AUTH_EXEMPT_HANDLERS.has(resolution.route.handler)) {
    const failure = await enforceAuth({ auth, source, credentialStore: deps.credentialStore, stderr: deps.stderr });
    if (failure !== null) {
      return failure;
    }
  }

  return resolution.route.handler(ctx, { ...parsed, args: resolution.rest });
}
