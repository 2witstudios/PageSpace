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
import { resolveAuth } from './auth/resolve.js';
import {
  drivesCreateHandler,
  drivesListHandler,
  drivesRenameHandler,
  drivesRestoreHandler,
  drivesTrashHandler,
} from './commands/drives.js';
import { pagesReadHandler, pagesReplaceLinesHandler } from './commands/content.js';
import { pagesExportHandler } from './commands/export.js';
import { helpHandler } from './commands/help.js';
import { loginHandler } from './commands/login.js';
import { loginDeviceHandler } from './commands/login-device.js';
import { logoutHandler } from './commands/logout.js';
import { mcpHandler } from './commands/mcp.js';
import {
  pagesCreateHandler,
  pagesListHandler,
  pagesMoveHandler,
  pagesReadDetailsHandler,
  pagesRenameHandler,
  pagesRestoreHandler,
  pagesTrashHandler,
  pagesTreeHandler,
} from './commands/pages.js';
import { sheetsEditCellsHandler } from './commands/sheets.js';
import {
  tasksAssignedHandler,
  tasksCreateHandler,
  tasksCreateStatusHandler,
  tasksDeleteHandler,
  tasksListHandler,
  tasksReorderHandler,
  tasksStatusesHandler,
  tasksUpdateHandler,
} from './commands/tasks.js';
import { trashListHandler } from './commands/trash.js';
import { versionHandler } from './commands/version.js';
import { whoamiHandler } from './commands/whoami.js';
import { tokensCreateHandler } from './commands/tokens/create.js';
import { tokensListHandler } from './commands/tokens/list.js';
import { tokensRevokeHandler } from './commands/tokens/revoke.js';
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
  /** Defaults to `false` (fail-closed) when omitted — only `bin.ts` knows the real terminal state. */
  readonly isTTY?: boolean;
  /** Defaults to a function that never resolves truthily when omitted; only called when `isTTY` is true. */
  readonly prompt?: (message: string) => Promise<string>;
}

const ROUTES: readonly Route[] = [
  { path: ['help'], handler: helpHandler },
  { path: ['login'], handler: loginHandler },
  { path: ['logout'], handler: logoutHandler },
  { path: ['whoami'], handler: whoamiHandler },
  { path: ['tokens', 'create'], handler: tokensCreateHandler },
  { path: ['tokens', 'list'], handler: tokensListHandler },
  { path: ['tokens', 'revoke'], handler: tokensRevokeHandler },
  { path: ['mcp'], handler: mcpHandler },
  { path: ['drives', 'list'], handler: drivesListHandler },
  { path: ['drives', 'create'], handler: drivesCreateHandler },
  { path: ['drives', 'rename'], handler: drivesRenameHandler },
  { path: ['drives', 'trash'], handler: drivesTrashHandler },
  { path: ['drives', 'restore'], handler: drivesRestoreHandler },
  { path: ['pages', 'list'], handler: pagesListHandler },
  { path: ['pages', 'tree'], handler: pagesTreeHandler },
  { path: ['pages', 'read-details'], handler: pagesReadDetailsHandler },
  { path: ['pages', 'create'], handler: pagesCreateHandler },
  { path: ['pages', 'rename'], handler: pagesRenameHandler },
  { path: ['pages', 'move'], handler: pagesMoveHandler },
  { path: ['pages', 'trash'], handler: pagesTrashHandler },
  { path: ['pages', 'restore'], handler: pagesRestoreHandler },
  { path: ['pages', 'read'], handler: pagesReadHandler },
  { path: ['pages', 'replace-lines'], handler: pagesReplaceLinesHandler },
  { path: ['pages', 'export'], handler: pagesExportHandler },
  { path: ['sheets', 'edit-cells'], handler: sheetsEditCellsHandler },
  { path: ['trash', 'list'], handler: trashListHandler },
  { path: ['tasks', 'list'], handler: tasksListHandler },
  { path: ['tasks', 'create'], handler: tasksCreateHandler },
  { path: ['tasks', 'update'], handler: tasksUpdateHandler },
  { path: ['tasks', 'delete'], handler: tasksDeleteHandler },
  { path: ['tasks', 'reorder'], handler: tasksReorderHandler },
  { path: ['tasks', 'statuses'], handler: tasksStatusesHandler },
  { path: ['tasks', 'create-status'], handler: tasksCreateStatusHandler },
  { path: ['tasks', 'assigned'], handler: tasksAssignedHandler },
];

/**
 * Commands that manage credentials themselves and never touch `ctx.sdk`:
 * `help` doesn't need auth; `login`/`login --device` establish it; `logout`/
 * `whoami` construct their own `CredentialStore` and do their own
 * discovery/refresh (matching `login.ts`'s sanctioned pattern) because
 * "not logged in" is a normal, graceful outcome for them, not a hard
 * failure — routing them through `enforceAuth` first would print this
 * resolver's generic message (and attempt a redundant refresh) ahead of
 * their own, more specific handling. `mcp` is NOT exempt — it authenticates
 * through `ctx.sdk` exactly like every other command below.
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

  const credential = await deps.credentialStore.get(host);
  const source = resolveAuth(
    { token: parsed.flags.token },
    { PAGESPACE_TOKEN: envToken.token },
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

  if (!AUTH_EXEMPT_HANDLERS.has(resolution.route.handler)) {
    const failure = await enforceAuth({ auth, source, credentialStore: deps.credentialStore, stderr: deps.stderr });
    if (failure !== null) {
      return failure;
    }
  }

  return resolution.route.handler(ctx, { ...parsed, args: resolution.rest });
}
