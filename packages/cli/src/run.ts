/**
 * run() — the composition root. Takes argv/env/stdout/stderr/credentialStore
 * as plain injected values (no `process.*` reference anywhere in this file)
 * and returns an exit code; `bin.ts` is the only caller that touches the
 * real process.
 */
import { AuthenticationError, PageSpaceClient } from '@pagespace/sdk';
import type { AuthProvider } from '@pagespace/sdk';
import { parseArgv } from './argv/parse.js';
import { buildAuthProvider, enforceAuth, FailingAuthProvider } from './auth/auth-context.js';
import { createDiscoverMetadata } from './auth/discover.js';
import { createLazyAuthProvider } from './auth/lazy-provider.js';
import { resolveEnvKeyName, resolveEnvToken } from './auth/legacy-token-env.js';
import { createRefreshAccessToken } from './auth/silent-refresh.js';
import { hasExplicitCredential, mcpNoExplicitCredentialMessage, noExplicitCredentialMessage } from './auth/resolve.js';
import { resolveCredentialSource } from './auth/resolve-credential-source.js';
import { loginHandler } from './commands/login.js';
import { loginDeviceHandler } from './commands/login-device.js';
import { logoutHandler } from './commands/logout.js';
import { createMcpHandler, mcpHandler } from './commands/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { tokensCreateHandler } from './commands/keys/create.js';
import { tokensListHandler } from './commands/keys/list.js';
import { tokensRevokeHandler } from './commands/keys/revoke.js';
import { keysUseHandler } from './commands/keys/use.js';
import { keysHandler } from './commands/keys/wizard.js';
import { versionHandler } from './commands/version.js';
import { whoamiHandler } from './commands/whoami.js';
import { resolveConfig } from './config/resolve.js';
import { createNullActiveKeyStore, type ActiveKeyStore } from './credentials/active-key.js';
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
  /**
   * The host → active-key-name map (`pagespace keys use`). Defaults to a
   * null store (no active key ever resolves; fail-closed) when omitted —
   * only `bin.ts` knows the real file location.
   */
  readonly activeKeyStore?: ActiveKeyStore;
  /** Defaults to `false` (fail-closed) when omitted — only `bin.ts` knows the real terminal state. */
  readonly isTTY?: boolean;
  /** Defaults to a function that never resolves truthily when omitted; only called when `isTTY` is true. */
  readonly prompt?: (message: string) => Promise<string>;
  /**
   * Test seam: when present and the mcp route is dispatched, the handler is
   * built around this transport factory instead of the module-level
   * `mcpHandler`'s real `StdioServerTransport` — `run(['mcp'])` in a test
   * must never attach a live stdio transport to the test runner's process.
   * `bin.ts` never sets it.
   */
  readonly createMcpTransport?: () => Transport;
}

/**
 * Commands that manage credentials themselves and never touch `ctx.sdk`'s
 * ambient-resolved auth source at all: `help` doesn't need auth; `login`/
 * `login --device` establish a credential from scratch; `logout`/`whoami`
 * construct their own `CredentialStore` and do their own discovery/refresh
 * (matching `login.ts`'s sanctioned pattern) because "not logged in" is a
 * normal, graceful outcome for them, not a hard failure.
 *
 * This set gates BOTH checks below — the ambient-credential-fallback gate
 * (first) and `enforceAuth` (second) — for the handlers above, since neither
 * check's subject (the `source`/`auth` built from `resolveAuth`'s flag > env
 * > stored-key precedence) is ever consulted by them. Every OTHER
 * handler, including `mcp`, DOES eventually authenticate through `ctx.sdk`
 * when given a credential, so both checks matter there: the ambient gate
 * refuses to even attempt that authentication on nothing but a stored
 * default/personal credential (originally Phase 8 task 4's `mcp`-only gate,
 * generalized here in Phase 9 task 4 to every command — a coding agent with
 * shell access must never be able to ride a human's `pagespace login`
 * credential into content access), and `enforceAuth` is what actually
 * materializes and validates whichever explicit source WAS given.
 *
 * The whole `pagespace keys` surface belongs here for the same reason
 * `login` does: it's the whole point of a bare `pagespace login`'s ambient
 * `manage_keys`-scoped credential. `keysHandler` (the guided wizard) lists,
 * mints (via its own browser-consent OAuth flow, Phase 8 task 2), and
 * revokes keys through `ctx.sdk` itself, with zero extra setup —
 * `tokensCreateHandler`/`tokensListHandler`/`tokensRevokeHandler`
 * (`commands/keys/create.ts`/`list.ts`/`revoke.ts`) back its flag-driven
 * `keys create`/`keys list`/`keys revoke` equivalents and are exempted for
 * the identical reason, as is `keysUseHandler` (`keys use` — the activation
 * ceremony is its own browser-consent step-up, and its server lookup rides
 * the same ambient `manage_keys` credential `keys list` does). (The
 * `tokens*` handler names predate the `keys` surface — Phase 4 task 6 first
 * shipped them under a since-removed `tokens` command family, folded into
 * `keys` by a later Phase 9 follow-up — hence the name.)
 */
const AUTH_EXEMPT_HANDLERS = new Set([
  helpHandler,
  loginHandler,
  logoutHandler,
  whoamiHandler,
  tokensCreateHandler,
  tokensListHandler,
  tokensRevokeHandler,
  keysUseHandler,
  keysHandler,
]);

/**
 * True when this argv will dispatch to a route declared `longRunning` in the
 * ROUTES table (today only `['mcp']`, whose handler resolves as soon as the
 * stdio transport connects while the server lives on the stdin handle) — so
 * `bin.ts` must NOT force-exit after `run()` settles for it, unlike every
 * other (one-shot) command. Resolved against the same route table `run()`
 * dispatches with, so adding a future long-running command is one route
 * property, not a second string check to remember here. Conservative by
 * design: a false positive only skips a belt-and-suspenders exit (the
 * natural event-loop drain still exits); a false negative would kill a live
 * server mid-session. `bin.ts` additionally requires a success exit code —
 * a long-running route that FAILED never started its server and must still
 * be force-exited.
 */
export function isLongRunningCommand(argv: readonly string[]): boolean {
  const parsed = parseArgv(argv);
  if (parsed.kind !== 'command' || parsed.flags.version) return false;
  if (parsed.flags.help && parsed.args.length === 0) return false;
  const resolution = resolveRoute(ROUTES, parsed.args);
  return resolution.kind === 'match' && resolution.route.longRunning === true;
}

export async function run(deps: RunDependencies): Promise<ExitCode> {
  const parsed = parseArgv(deps.argv);
  if (parsed.kind === 'usage-error') {
    deps.stderr.write(`${parsed.message}\n`);
    return EXIT_USAGE_ERROR;
  }

  const { host } = resolveConfig({
    flags: { host: parsed.flags.host },
    env: { PAGESPACE_API_URL: deps.env.PAGESPACE_API_URL },
    credential: null,
  });

  const envToken = resolveEnvToken(deps.env);
  if (envToken.deprecationNotice) {
    deps.stderr.write(`${envToken.deprecationNotice}\n`);
  }

  const envKey = resolveEnvKeyName(deps.env);
  if (envKey.deprecationNotice) {
    deps.stderr.write(`${envKey.deprecationNotice}\n`);
  }

  const activeKeyStore = deps.activeKeyStore ?? createNullActiveKeyStore();

  // Route resolution is pure, so it can inform auth resolution here even
  // though dispatch (and the shortcut flags that bypass routing entirely)
  // happens further down against this same result.
  const resolution = resolveRoute(ROUTES, parsed.args);
  const routedHandler = resolution.kind === 'match' ? resolution.route.handler : null;
  const isAuthExempt = routedHandler !== null && AUTH_EXEMPT_HANDLERS.has(routedHandler);

  // The active key (`pagespace keys use`) is the lowest-priority source, and
  // only for gated CONTENT commands: explicit --token/--key/env always wins
  // (`explicit` below), auth-exempt handlers keep their ambient login
  // credential (the keys family needs its `manage_keys` scope, which a
  // drive-scoped active key doesn't carry), and `pagespace mcp` — invoked
  // unattended by an MCP client — deliberately never rides a human's
  // per-machine activation (its config must name a credential itself).
  const activeKeyEligible = routedHandler !== null && !isAuthExempt && routedHandler !== mcpHandler;

  const isLazyAuthRoute = resolution.kind === 'match' && resolution.route.lazyAuth === true;

  const authProviderDeps = {
    discoverMetadata: createDiscoverMetadata(),
    createRefreshAccessToken,
    credentialStore: deps.credentialStore,
    now: Date.now,
  };

  let auth: AuthProvider;
  let source: Awaited<ReturnType<typeof resolveCredentialSource>>['source'] | null;
  let activeKeyName: string | null;
  let explicit: boolean;

  if (isLazyAuthRoute) {
    // A lazy-auth route (today only `mcp`) serves a protocol whose client
    // can only see a startup failure as a silent hang, so NOTHING about the
    // credential may run before the handler connects its transport: no
    // credential-store read (a native keychain call that can block on an
    // access prompt when spawned headless by an MCP client), no OAuth
    // discovery/refresh (unbounded-feeling network I/O against a possibly
    // dead host), no store purge. The Phase 8 task 4 invariant — never ride
    // the human's ambient login credential — is preserved *structurally*
    // here: with nothing explicit given, `resolveCredentialSource` is never
    // called at all, so the ambient stored credential cannot even be read,
    // and the wired provider fails every call with the actionable mcp
    // message. With an explicit credential named, resolution (including the
    // keychain read, bounded below) and any discovery/refresh move to the
    // first `getAccessToken()` — i.e. the first tool call — where a failure
    // surfaces as that call's error result through the live server.
    explicit = hasExplicitCredential({ token: parsed.flags.token, key: parsed.flags.key }, deps.env);
    source = null;
    activeKeyName = null;
    auth = explicit
      ? createLazyAuthProvider(async () => {
          const resolved = await resolveWithTimeout(
            resolveCredentialSource({
              flags: { token: parsed.flags.token, key: parsed.flags.key },
              env: deps.env,
              host,
              credentialStore: deps.credentialStore,
              activeKeyStore,
              allowActiveKey: false,
            }),
            CREDENTIAL_STORE_READ_TIMEOUT_MS,
          );
          return buildAuthProvider(resolved.source, authProviderDeps);
        })
      : new FailingAuthProvider(mcpNoExplicitCredentialMessage());
  } else {
    const resolved = await resolveCredentialSource({
      flags: { token: parsed.flags.token, key: parsed.flags.key },
      env: deps.env,
      host,
      credentialStore: deps.credentialStore,
      activeKeyStore,
      allowActiveKey: activeKeyEligible,
    });
    source = resolved.source;
    activeKeyName = resolved.activeKeyName;
    explicit = resolved.explicit;
    auth = buildAuthProvider(resolved.source, authProviderDeps);
  }

  const ctx: HandlerContext = {
    sdk: new PageSpaceClient({ baseUrl: host, auth }),
    stdout: deps.stdout,
    stderr: deps.stderr,
    env: deps.env,
    credentialStore: deps.credentialStore,
    activeKeyStore,
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

  if (resolution.kind === 'usage-error') {
    deps.stderr.write(`${resolution.message}\n`);
    return EXIT_USAGE_ERROR;
  }

  if (!isAuthExempt && !isLazyAuthRoute && !explicit && activeKeyName === null) {
    // Must run before `enforceAuth` below: that call materializes `source` by
    // calling `auth.getAccessToken()`, which for a `kind: 'stored'` source
    // (the ambient "default"/personal credential falling through here with
    // nothing explicit given) performs a real discovery + refresh-token
    // network exchange and rotates the stored personal credential — exactly
    // the fallback this gate exists to block, for every command that isn't
    // exempt above (Phase 8 task 4, generalized in Phase 9 task 4). Checking
    // first means that network/store effect never happens at all, not just
    // that the command never runs afterward. An active key (checked above,
    // never for `mcp`) satisfies this gate for content commands: a human
    // approved exactly that key for this machine in a browser.
    //
    // Lazy-auth routes (`mcp`) are exempted from this early *exit* but not
    // from the invariant it protects: their no-explicit-credential case was
    // handled above by wiring a `FailingAuthProvider` WITHOUT ever calling
    // `resolveCredentialSource` — strictly stronger than this gate, which
    // runs after that resolver has already read the store. Exiting here
    // would recreate the exact failure this route shape exists to avoid: a
    // child that dies before its transport connects is indistinguishable
    // from a hung server to the MCP client on the other end of the pipe.
    deps.stderr.write(
      `${resolution.route.handler === mcpHandler ? mcpNoExplicitCredentialMessage() : noExplicitCredentialMessage()}\n`,
    );
    return EXIT_RUNTIME_ERROR;
  }

  if (!isAuthExempt && !isLazyAuthRoute && source !== null) {
    // Deliberately skipped for lazy-auth routes: `enforceAuth` materializes
    // a token (discovery + refresh network I/O) before the handler runs —
    // pre-transport death on failure — and its stored-credential purge fires
    // on ANY AuthenticationError, which a long outage can produce
    // transiently; wiping the stored key over that turns a temporary outage
    // into a permanent re-login. Lazy routes surface auth failures per call
    // instead, and never purge.
    const failure = await enforceAuth({ auth, source, credentialStore: deps.credentialStore, stderr: deps.stderr });
    if (failure !== null) {
      return failure;
    }
  }

  const handler =
    deps.createMcpTransport !== undefined && resolution.route.handler === mcpHandler
      ? createMcpHandler({ createTransport: deps.createMcpTransport })
      : resolution.route.handler;
  return handler(ctx, { ...parsed, args: resolution.rest });
}

/**
 * Bounds the lazy credential-store read for lazy-auth routes: on macOS a
 * keychain read can surface a GUI access prompt, which never gets answered
 * when the process was spawned headless by an MCP client — without a bound
 * the first tool call would hang exactly the way startup used to.
 */
const CREDENTIAL_STORE_READ_TIMEOUT_MS = 5_000;

async function resolveWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new AuthenticationError(
              `Reading the stored credential timed out after ${timeoutMs}ms — the OS keychain may be locked or ` +
                'waiting on an access prompt this process cannot show. Pass --token (or set PAGESPACE_TOKEN) in ' +
                'the MCP config to avoid the credential store entirely.',
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
