/**
 * `pagespace tokens create` (Phase 8 task 2). Mints a scoped credential the
 * same way `pagespace login` mints an unscoped one: opens a browser to the
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
import { resolveConfig } from '../../config/resolve.js';
import { DEFAULT_PROFILE_NAME } from '../../credentials/serialize.js';
import { createCredentialStore } from '../../credentials/store.js';
import type { CredentialStore } from '../../credentials/store.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../../exit-codes.js';
import type { CommandHandler } from '../../router/router.js';
import { confirmIdentity } from '../../auth/confirm-identity.js';
import { createDiscoverMetadata } from '../../auth/discover.js';
import { createExchangeCode } from '../../auth/exchange-code.js';
import { createLoopbackServer } from '../../auth/create-loopback-server.js';
import { openBrowser } from '../../auth/open-browser.js';
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

export type ResolveTokenProfileNameResult = { readonly ok: true; readonly name: string } | { readonly ok: false; readonly message: string };

/**
 * `--save-as-profile` if given, else the sole drive's id — ambiguous for
 * multiple drives. The `"default"` name is refused outright: that slot holds
 * the personal credential `pagespace login` stores, and letting a scoped
 * token land there would let either credential silently clobber the other.
 */
export function resolveTokenProfileName({
  saveAsProfile,
  drives,
}: Pick<CreateTokenArgs, 'saveAsProfile' | 'drives'>): ResolveTokenProfileNameResult {
  if (saveAsProfile === DEFAULT_PROFILE_NAME) {
    return {
      ok: false,
      message: `--save-as-profile "${DEFAULT_PROFILE_NAME}" is reserved for the personal credential stored by "pagespace login". Choose another profile name.`,
    };
  }
  if (saveAsProfile !== undefined) {
    return { ok: true, name: saveAsProfile };
  }
  if (drives.length === 1) {
    return { ok: true, name: drives[0].id };
  }
  return {
    ok: false,
    message: '--save-as-profile <name> is required when scoping a token to more than one drive.',
  };
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

    ctx.stdout.write(`Opening your browser to approve access for profile "${profileName}" on ${host}...\n`);

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
    });

    switch (result.outcome) {
      case 'success':
        ctx.stdout.write(`Created profile "${profileName}" on ${host}, scoped to: ${scopeResult.scope}.\n`);
        return EXIT_SUCCESS;
      case 'timeout':
        ctx.stderr.write('Consent timed out waiting for the browser redirect. Run "pagespace tokens create" again.\n');
        return EXIT_RUNTIME_ERROR;
      case 'state_mismatch':
        ctx.stderr.write(
          'Consent failed: the authorization response did not match this request. Run "pagespace tokens create" again.\n',
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
  waitMs: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  exchangeCode: createExchangeCode(),
  confirmIdentity,
  now: Date.now,
});
