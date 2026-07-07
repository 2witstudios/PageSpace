/**
 * `pagespace keys create` (Phase 8 task 2; the sole minting surface since the
 * Phase 9 follow-up folded the old `tokens create` command into `keys`).
 * Mints a scoped credential the same way `pagespace login` mints an unscoped
 * one: opens a browser to the
 * OAuth authorize/consent screen and runs the loopback+PKCE state machine
 * (`runLoopbackLogin`) with a `drive:<id>:<role> offline_access` scope
 * instead of `login`'s `account offline_access`. There is no other minting
 * path in this CLI — the previous direct `POST /api/auth/mcp-tokens` call
 * (authenticated by whatever ambient credential `resolveAuth` happened to
 * find, with no human-visible step) is gone. That REST endpoint still backs
 * the web Settings > MCP page's own "create token" button, which is already
 * a human in an authenticated browser tab clicking a button — this command
 * now requires the same trust level instead of routing around it.
 *
 * The resulting refresh token is persisted under a named profile
 * (`--save-as-profile`, falling back to the single drive's id), never the
 * `"default"` profile `pagespace login` uses — so minting a scoped token
 * can't silently overwrite (or be overwritten by) a personal login
 * credential for the same host.
 */
import { randomBytes } from 'node:crypto';
import { PAGESPACE_CLI_CLIENT_ID } from '../../auth/client.js';
import { TOKEN_ENV_VAR_NAME } from '../../auth/resolve.js';
import { resolveConfig } from '../../config/resolve.js';
import { DEFAULT_PROFILE_NAME } from '../../credentials/serialize.js';
import { createCredentialStore } from '../../credentials/store.js';
import type { CredentialStore } from '../../credentials/store.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../../exit-codes.js';
import type { OutputSink } from '../../handler-context.js';
import type { CommandHandler } from '../../router/router.js';
import { confirmIdentity } from '../../auth/confirm-identity.js';
import { createDiscoverMetadata } from '../../auth/discover.js';
import { createExchangeCode } from '../../auth/exchange-code.js';
import { createLoopbackServer } from '../../auth/create-loopback-server.js';
import { openBrowser } from '../../auth/open-browser.js';
import { unrefWaitMs } from '../../auth/wait.js';
import { runLoopbackLogin } from '../../auth/loopback-flow.js';
import { DEFAULT_LOGIN_TIMEOUT_MS, DEFAULT_MAX_PORT_ATTEMPTS } from '../login.js';
import type {
  ConfirmIdentity,
  DiscoverMetadata,
  ExchangeCode,
  OpenBrowser,
  RandomBytes,
  StartLoopbackServer,
  WaitMs,
} from '../../auth/loopback-flow.js';
import { parseTokensCreateArgs, type CreateTokenArgs, type DriveScopeArg } from './args.js';
import { renderAgentWiringGuidance } from './guidance.js';

const RESOURCE_ID_PATTERN = /^[a-z0-9]{1,32}$/;

function isResourceId(value: string): boolean {
  return RESOURCE_ID_PATTERN.test(value);
}

function formatDriveScope({ id, role, customRoleId }: DriveScopeArg): string {
  if (role === 'ADMIN') return `drive:${id}:admin`;
  if (role === 'MEMBER') return `drive:${id}:member`;
  if (customRoleId !== undefined) return `drive:${id}:role:${customRoleId}`;
  return `drive:${id}`;
}

export type BuildTokenScopeResult = { readonly ok: true; readonly scope: string } | { readonly ok: false; readonly message: string };

/**
 * Maps `--drive`/`--role` flags to the OAuth drive-scope grammar
 * (`drive:<id>[:admin|:member|:role:<customRoleId>] ... offline_access`,
 * `packages/lib/src/auth/oauth/scopes.ts`). Reimplemented here rather than
 * imported so the published CLI never runtime-imports `@pagespace/lib` (see
 * `auth/client.ts` for the same reasoning) — `parseScopeList` from that
 * package is still used, but only in this module's test file, as a
 * devDependency-only drift guard against the canonical grammar.
 */
export function buildTokenScope(drives: readonly DriveScopeArg[]): BuildTokenScopeResult {
  if (drives.length === 0) {
    return { ok: false, message: 'At least one --drive is required to create a scoped token.' };
  }

  const invalidDrive = drives.find((drive) => !isResourceId(drive.id));
  if (invalidDrive) {
    return {
      ok: false,
      message: `Invalid --drive value "${invalidDrive.id}": drive IDs are 1-32 lowercase letters/digits.`,
    };
  }

  const invalidRole = drives.find((drive) => drive.customRoleId !== undefined && !isResourceId(drive.customRoleId));
  if (invalidRole) {
    return {
      ok: false,
      message: `Invalid --role value "${invalidRole.customRoleId}": custom role IDs are 1-32 lowercase letters/digits.`,
    };
  }

  const seenDriveIds = new Set<string>();
  const duplicateDrive = drives.find((drive) => {
    if (seenDriveIds.has(drive.id)) return true;
    seenDriveIds.add(drive.id);
    return false;
  });
  if (duplicateDrive) {
    return { ok: false, message: `Duplicate --drive "${duplicateDrive.id}": each drive may only be scoped once.` };
  }

  const driveScopeTokens = [...drives].sort((a, b) => a.id.localeCompare(b.id)).map(formatDriveScope);
  return { ok: true, scope: [...driveScopeTokens, 'offline_access'].join(' ') };
}

export type BuildKeyUpdateScopeResult =
  | {
      readonly ok: true;
      /** The full wire scope: `update_key:<tokenId> drive:...`. */
      readonly scope: string;
      /** Just the drive tokens — what the wizard shows the user (the update_key token is plumbing, not a grant). */
      readonly driveScope: string;
    }
  | { readonly ok: false; readonly message: string };

/**
 * The in-place re-scope variant of `buildTokenScope` (the wizard's Edit
 * flow): `update_key:<tokenId>` + the same sorted drive tokens, WITHOUT
 * `offline_access` — this grant mints nothing refreshable (the server
 * rejects the combination outright, `scopes.ts`'s `update_key_conflict`).
 * Same reimplemented-grammar reasoning as `buildTokenScope` above; the test
 * file drift-guards both against `parseScopeList`.
 */
export function buildKeyUpdateScope(tokenId: string, drives: readonly DriveScopeArg[]): BuildKeyUpdateScopeResult {
  if (!isResourceId(tokenId)) {
    return { ok: false, message: `Invalid key id "${tokenId}": key ids are 1-32 lowercase letters/digits.` };
  }
  const base = buildTokenScope(drives);
  if (!base.ok) return base;
  const driveScope = base.scope
    .split(' ')
    .filter((token) => token !== 'offline_access')
    .join(' ');
  return { ok: true, scope: `update_key:${tokenId} ${driveScope}`, driveScope };
}

export type ResolveTokenProfileNameResult = { readonly ok: true; readonly name: string } | { readonly ok: false; readonly message: string };

/**
 * `--save-as-profile` if given, else the sole drive's id — ambiguous for
 * multiple drives. Whichever branch resolves the name, `"default"` is
 * refused outright: that slot holds the personal credential `pagespace
 * login` stores, and letting a scoped token land there (whether named
 * explicitly or auto-derived from a drive literally named "default") would
 * let either credential silently clobber the other.
 */
export function resolveTokenProfileName({
  saveAsProfile,
  drives,
}: Pick<CreateTokenArgs, 'saveAsProfile' | 'drives'>): ResolveTokenProfileNameResult {
  if (saveAsProfile === undefined && drives.length !== 1) {
    return {
      ok: false,
      message: '--save-as-profile <name> is required when scoping a token to more than one drive.',
    };
  }
  const resolvedName = saveAsProfile ?? drives[0].id;
  if (resolvedName === DEFAULT_PROFILE_NAME) {
    return {
      ok: false,
      message: `--save-as-profile "${DEFAULT_PROFILE_NAME}" is reserved for the personal credential stored by "pagespace login". Choose another profile name.`,
    };
  }
  return { ok: true, name: resolvedName };
}

export interface TokensCreateHandlerDeps {
  readonly createCredentialStore: () => CredentialStore;
  readonly randomBytes: RandomBytes;
  readonly discoverMetadata: DiscoverMetadata;
  readonly startServer: StartLoopbackServer;
  readonly openBrowser: OpenBrowser;
  readonly waitMs: WaitMs;
  readonly exchangeCode: ExchangeCode;
  readonly confirmIdentity: ConfirmIdentity;
  readonly now: () => number;
  readonly timeoutMs?: number;
  readonly maxPortAttempts?: number;
}

export function createTokensCreateHandler(deps: TokensCreateHandlerDeps): CommandHandler {
  return async (ctx, intent) => {
    const parsedArgs = parseTokensCreateArgs(intent.args);
    if (!parsedArgs.ok) {
      ctx.stderr.write(`${parsedArgs.message}\n`);
      return EXIT_USAGE_ERROR;
    }

    const scopeResult = buildTokenScope(parsedArgs.args.drives);
    if (!scopeResult.ok) {
      ctx.stderr.write(`${scopeResult.message}\n`);
      return EXIT_USAGE_ERROR;
    }

    const profileResult = resolveTokenProfileName(parsedArgs.args);
    if (!profileResult.ok) {
      ctx.stderr.write(`${profileResult.message}\n`);
      return EXIT_USAGE_ERROR;
    }
    const profileName = profileResult.name;

    const { host } = resolveConfig({
      flags: { host: intent.flags.host },
      env: { PAGESPACE_API_URL: ctx.env.PAGESPACE_API_URL },
      profile: null,
    });

    const store = deps.createCredentialStore();
    const existing = await store.get(host, profileName);
    if (existing && !intent.flags.yes) {
      ctx.stderr.write(
        `A stored credential for ${host} (profile "${profileName}") already exists. Re-run with --yes to overwrite it, or "pagespace logout --host ${host} --profile ${profileName}" first.\n`,
      );
      return EXIT_RUNTIME_ERROR;
    }

    // With --show-token, stdout is a machine-readable contract: it carries
    // EXACTLY one line — the token env-var assignment — and nothing else, so
    // `... --show-token | pbcopy` (or a $(...) capture) yields a usable
    // value. Every human-readable line — progress, success, guidance —
    // routes to stderr in that mode; without the flag, stdout keeps its
    // ordinary informational role.
    const info: OutputSink = parsedArgs.args.showToken ? ctx.stderr : ctx.stdout;

    info.write(`Opening your browser to approve access for profile "${profileName}" on ${host}...\n`);

    // Captured, never printed inline: the callback fires mid-flow, and the
    // token must only ever surface behind the explicit --show-token opt-in.
    let mintedToken: string | null = null;

    const result = await runLoopbackLogin({
      host,
      clientId: PAGESPACE_CLI_CLIENT_ID,
      scope: scopeResult.scope,
      randomBytes: deps.randomBytes,
      discoverMetadata: deps.discoverMetadata,
      startServer: deps.startServer,
      maxPortAttempts: deps.maxPortAttempts ?? DEFAULT_MAX_PORT_ATTEMPTS,
      openBrowser: deps.openBrowser,
      onBrowserOpenFailed: (url) => {
        ctx.stderr.write(`Could not open a browser automatically. Open this URL to continue:\n${url}\n`);
      },
      waitMs: deps.waitMs,
      timeoutMs: deps.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS,
      exchangeCode: deps.exchangeCode,
      confirmIdentity: deps.confirmIdentity,
      credentialStore: store,
      now: deps.now,
      profile: profileName,
      onMintedStaticToken: (token) => {
        mintedToken = token;
      },
    });

    switch (result.outcome) {
      case 'success':
        info.write(`Created profile "${profileName}" on ${host}, scoped to: ${scopeResult.scope}.\n`);
        if (parsedArgs.args.showToken) {
          if (mintedToken !== null) {
            // The ONLY stdout line in --show-token mode (see `info` above).
            ctx.stdout.write(`${TOKEN_ENV_VAR_NAME}=${mintedToken}\n`);
            ctx.stderr.write("This token is shown once and never again. Anyone holding it gets this key's access.\n");
          } else {
            ctx.stderr.write('--show-token: no raw token to show — the server returned a refresh credential instead of a static token.\n');
          }
        }
        info.write(`${renderAgentWiringGuidance({ profileName, host }).join('\n')}\n`);
        return EXIT_SUCCESS;
      case 'timeout':
        ctx.stderr.write('Consent timed out waiting for the browser redirect. Run "pagespace keys create" again.\n');
        return EXIT_RUNTIME_ERROR;
      case 'state_mismatch':
        ctx.stderr.write(
          'Consent failed: the authorization response did not match this request. Run "pagespace keys create" again.\n',
        );
        return EXIT_RUNTIME_ERROR;
      case 'access_denied':
        ctx.stderr.write('Consent was denied.\n');
        return EXIT_RUNTIME_ERROR;
      case 'authorize_error':
        ctx.stderr.write(`Consent failed: ${result.error}\n`);
        return EXIT_RUNTIME_ERROR;
      case 'token_exchange_failed':
        ctx.stderr.write(`Consent failed while exchanging the authorization code: ${result.message}\n`);
        return EXIT_RUNTIME_ERROR;
      case 'port_bind_failed':
        ctx.stderr.write('Could not bind a local loopback port to receive the consent redirect.\n');
        return EXIT_RUNTIME_ERROR;
      case 'discovery_failed':
        ctx.stderr.write(`Could not discover the OAuth server configuration for ${host}: ${result.message}\n`);
        return EXIT_RUNTIME_ERROR;
      default: {
        const unreachable: never = result;
        throw new Error(`Unhandled consent outcome: ${JSON.stringify(unreachable)}`);
      }
    }
  };
}

function nodeRandomBytes(length: number): Uint8Array {
  return new Uint8Array(randomBytes(length));
}

export const tokensCreateHandler: CommandHandler = createTokensCreateHandler({
  createCredentialStore,
  randomBytes: nodeRandomBytes,
  discoverMetadata: createDiscoverMetadata(),
  startServer: createLoopbackServer,
  openBrowser,
  waitMs: unrefWaitMs,
  exchangeCode: createExchangeCode(),
  confirmIdentity,
  now: Date.now,
});
