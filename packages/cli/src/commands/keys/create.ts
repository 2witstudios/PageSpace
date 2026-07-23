/**
 * `pagespace keys create` (Phase 8 task 2; the sole minting surface since the
 * Phase 9 follow-up folded the old `tokens create` command into `keys`).
 * Mints a scoped credential the same way `pagespace login` mints an unscoped
 * one: opens a browser to the
 * OAuth authorize/consent screen and runs the loopback+PKCE state machine
 * (`runLoopbackLogin`) with a `drive:<id>:<role> offline_access` scope
 * instead of `login`'s `manage_keys offline_access`. There is no other minting
 * path in this CLI — the previous direct `POST /api/auth/mcp-tokens` call
 * (authenticated by whatever ambient credential `resolveAuth` happened to
 * find, with no human-visible step) is gone. That REST endpoint still backs
 * the web Settings > MCP page's own "create token" button, which is already
 * a human in an authenticated browser tab clicking a button — this command
 * now requires the same trust level instead of routing around it.
 *
 * The resulting credential is persisted under the key's name (`--name`,
 * falling back to the single drive's id), never the `"default"` slot
 * `pagespace login` uses — so minting a scoped key can't silently overwrite
 * (or be overwritten by) a personal login credential for the same host.
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
import { confirmationFailureMessage, confirmDestructive } from '../../confirm.js';
import { createDiscoverMetadata } from '../../auth/discover.js';
import { createExchangeCode } from '../../auth/exchange-code.js';
import { createLoopbackServer } from '../../auth/create-loopback-server.js';
import { openBrowser } from '../../auth/open-browser.js';
import { unrefWaitMs } from '../../auth/wait.js';
import { renderDeviceCodePrompt, runConsent } from '../../auth/run-consent.js';
import { createPollDeviceToken } from '../../auth/poll-device-token.js';
import { createRequestDeviceAuthorization } from '../../auth/request-device-authorization.js';
import { createSigintFlag } from '../../auth/sigint.js';
import type { PollDeviceToken, RequestDeviceAuthorization } from '../../auth/device-flow.js';
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

export type BuildTokenScopeResult =
  | {
      readonly ok: true;
      /** The full wire scope, including `name:...` when a name was given. */
      readonly scope: string;
      /** Human-readable, display-only: the drive/all-drives grant without the `name:...` plumbing token or `offline_access`. */
      readonly driveScope: string;
    }
  | { readonly ok: false; readonly message: string };

/**
 * Maps `--drive`/`--role` flags to the OAuth drive-scope grammar
 * (`drive:<id>[:admin|:member|:role:<customRoleId>] ... offline_access`,
 * `packages/lib/src/auth/oauth/scopes.ts`). Reimplemented here rather than
 * imported so the published CLI never runtime-imports `@pagespace/lib` (see
 * `auth/client.ts` for the same reasoning) — `parseScopeList` from that
 * package is still used, but only in this module's test file, as a
 * devDependency-only drift guard against the canonical grammar.
 *
 * `options.allDrives` is the ONLY way this function produces the `all_drives`
 * grant — never inferred from `drives.length === 0`, which is exactly the
 * ambiguity this flag exists to avoid (a bare "no --drive given" usage error
 * must stay a usage error, not silently escalate to an unrestricted key).
 *
 * `options.name`, when given, is embedded as a `name:<percent-encoded>` wire
 * token (required server-side on every mint-shaped grant — enforced at
 * `POST /api/oauth/authorize` via `validateAuthorizeRequest`, not by
 * `scopes.ts`'s parser itself). Omitted by `buildKeyUpdateScope` below, which
 * reuses this function for its drive-token list only — `update_key:*` grants
 * must never carry a name (`scopes.ts`'s `name_without_mint_grant`).
 */
export function buildTokenScope(
  drives: readonly DriveScopeArg[],
  options: { readonly name?: string; readonly allDrives?: boolean } = {},
): BuildTokenScopeResult {
  const nameToken = options.name !== undefined ? [`name:${encodeURIComponent(options.name)}`] : [];

  if (options.allDrives) {
    if (drives.length > 0) {
      return { ok: false, message: '--all-drives cannot be combined with --drive.' };
    }
    return { ok: true, scope: ['all_drives', ...nameToken, 'offline_access'].join(' '), driveScope: 'all drives' };
  }

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
  const driveScope = driveScopeTokens.join(' ');
  return { ok: true, scope: [...driveScopeTokens, ...nameToken, 'offline_access'].join(' '), driveScope };
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
  return { ok: true, scope: `update_key:${tokenId} ${base.driveScope}`, driveScope: base.driveScope };
}

export type BuildKeyActivateScopeResult =
  | { readonly ok: true; readonly scope: string }
  | { readonly ok: false; readonly message: string };

/**
 * The activation-ceremony scope (`pagespace keys use`): `activate_key:<tokenId>`
 * as the SOLE scope token — the grant verifies ownership of an existing key
 * and changes nothing server-side (`ok_mcp_activate`), so there is nothing
 * else to grant alongside it. Same reimplemented-grammar reasoning as
 * `buildTokenScope` above.
 */
export function buildKeyActivateScope(tokenId: string): BuildKeyActivateScopeResult {
  if (!isResourceId(tokenId)) {
    return { ok: false, message: `Invalid key id "${tokenId}": key ids are 1-32 lowercase letters/digits.` };
  }
  return { ok: true, scope: `activate_key:${tokenId}` };
}

export type ResolveNewKeyNameResult = { readonly ok: true; readonly name: string } | { readonly ok: false; readonly message: string };

/**
 * `--name` if given, else the sole drive's id — ambiguous for multiple
 * drives, and for `--all-drives` there is no drive id to fall back on at all,
 * so `--name` is required outright. Whichever branch resolves the name,
 * `"default"` is refused outright: that slot holds your login credential
 * (stored by `pagespace login`), and letting a scoped key land there (whether
 * named explicitly or auto-derived from a drive literally named "default")
 * would let either credential silently clobber the other.
 *
 * Runs BEFORE `buildTokenScope` in the create handler (the name must be
 * embedded inside the scope string it builds) — so the true "no --drive at
 * all" usage error must be raised HERE too, not left for `buildTokenScope`'s
 * own "at least one --drive is required" check to catch downstream; letting
 * it fall through to the "more than one drive" branch below would surface a
 * confusing --name-shaped message for what's actually a missing --drive.
 */
export function resolveNewKeyName({
  name,
  drives,
  allDrives,
}: Pick<CreateTokenArgs, 'name' | 'drives'> & { readonly allDrives?: boolean }): ResolveNewKeyNameResult {
  if (allDrives && name === undefined) {
    return {
      ok: false,
      message: '--name <name> is required when using --all-drives.',
    };
  }
  if (!allDrives && drives.length === 0) {
    return {
      ok: false,
      message: 'At least one --drive is required to create a scoped token.',
    };
  }
  if (!allDrives && name === undefined && drives.length !== 1) {
    return {
      ok: false,
      message: '--name <name> is required when scoping a key to more than one drive.',
    };
  }
  const resolvedName = name ?? drives[0].id;
  if (resolvedName === DEFAULT_PROFILE_NAME) {
    return {
      ok: false,
      message: `--name "${DEFAULT_PROFILE_NAME}" is reserved for the personal credential stored by "pagespace login". Choose another key name.`,
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
  readonly requestDeviceAuthorization: RequestDeviceAuthorization;
  readonly pollDeviceToken: PollDeviceToken;
  readonly isInterrupted: () => boolean;
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

    // Structural validation (--all-drives/--drive conflict, duplicate drive
    // ids, invalid drive/role id shape, zero drives) runs FIRST and without a
    // name — these are more specific, more actionable errors than
    // resolveNewKeyName's generic "--name is required" messages, and must
    // take precedence so e.g. `--all-drives --drive x` (no --name) reports
    // the actual flag conflict, not a --name nag that only leads to a second
    // round trip once corrected.
    const structuralCheck = buildTokenScope(parsedArgs.args.drives, { allDrives: parsedArgs.args.allDrives });
    if (!structuralCheck.ok) {
      ctx.stderr.write(`${structuralCheck.message}\n`);
      return EXIT_USAGE_ERROR;
    }

    // The server refuses an all_drives grant at the device door — such a key
    // can only be minted unambiguously through the authorization-code
    // exchange (see apps/web/src/app/api/oauth/device_authorization/route.ts).
    // Caught locally so the user gets the reason and the workaround up front,
    // instead of an opaque invalid_scope after typing a code into a browser.
    if (parsedArgs.args.allDrives && intent.flags.device) {
      ctx.stderr.write(
        '--all-drives cannot be combined with --device: an all-drives key must be approved through the browser flow. ' +
          'Run "pagespace keys create --all-drives --name <name>" on a machine with a browser, or scope the key to ' +
          'specific drives with --drive to use --device.\n',
      );
      return EXIT_USAGE_ERROR;
    }

    const nameResult = resolveNewKeyName(parsedArgs.args);
    if (!nameResult.ok) {
      ctx.stderr.write(`${nameResult.message}\n`);
      return EXIT_USAGE_ERROR;
    }
    const keyName = nameResult.name;

    // Re-run with the resolved name to embed it in the wire scope string.
    // Guaranteed to succeed given structuralCheck already passed on the same
    // (drives, allDrives) input — the ok:false branch below is unreachable
    // defense-in-depth, not a real path.
    const scopeResult = buildTokenScope(parsedArgs.args.drives, { name: keyName, allDrives: parsedArgs.args.allDrives });
    if (!scopeResult.ok) {
      ctx.stderr.write(`${scopeResult.message}\n`);
      return EXIT_USAGE_ERROR;
    }

    // Safety gate for the "quick flag typo mints a max-privilege key" risk:
    // --all-drives requires --yes (scriptable/CI) or an interactive TTY
    // confirm — the same shared confirmDestructive gate `keys revoke` uses.
    if (parsedArgs.args.allDrives) {
      const confirmation = await confirmDestructive(
        'This will mint a key with access to ALL your drives. Continue? [y/N] ',
        { isTTY: ctx.isTTY, yes: intent.flags.yes, prompt: ctx.prompt },
      );
      if (!confirmation.ok) {
        ctx.stderr.write(`${confirmationFailureMessage(confirmation)}\n`);
        return EXIT_RUNTIME_ERROR;
      }
    }

    const { host } = resolveConfig({
      flags: { host: intent.flags.host },
      env: { PAGESPACE_API_URL: ctx.env.PAGESPACE_API_URL },
      credential: null,
    });

    const store = deps.createCredentialStore();
    const existing = await store.get(host, keyName);
    if (existing && !intent.flags.yes) {
      ctx.stderr.write(
        `A stored credential for ${host} (key "${keyName}") already exists. Re-run with --yes to overwrite it, or "pagespace logout --host ${host} --key ${keyName}" first.\n`,
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

    if (!intent.flags.device) {
      info.write(`Opening your browser to approve access for key "${keyName}" on ${host}...\n`);
    }

    // Captured, never printed inline: the callback fires mid-flow, and the
    // token must only ever surface behind the explicit --show-token opt-in.
    let mintedToken: string | null = null;

    const result = await runConsent(
      {
        device: intent.flags.device,
        host,
        clientId: PAGESPACE_CLI_CLIENT_ID,
        scope: scopeResult.scope,
        discoverMetadata: deps.discoverMetadata,
        exchangeCode: deps.exchangeCode,
        confirmIdentity: deps.confirmIdentity,
        credentialStore: store,
        waitMs: deps.waitMs,
        now: deps.now,
        timeoutMs: deps.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS,
        profile: keyName,
        onMintedStaticToken: (token) => {
          mintedToken = token;
        },
        loopback: {
          randomBytes: deps.randomBytes,
          startServer: deps.startServer,
          openBrowser: deps.openBrowser,
          maxPortAttempts: deps.maxPortAttempts ?? DEFAULT_MAX_PORT_ATTEMPTS,
          onBrowserOpenFailed: (url) => {
            ctx.stderr.write(`Could not open a browser automatically. Open this URL to continue:\n${url}\n`);
          },
        },
        deviceDeps: {
          requestDeviceAuthorization: deps.requestDeviceAuthorization,
          pollDeviceToken: deps.pollDeviceToken,
          isInterrupted: deps.isInterrupted,
          onDeviceCode: (authorization) => {
            // Routed through `info` so --show-token's one-line stdout contract
            // holds for the device flow too.
            info.write(`${renderDeviceCodePrompt(authorization).join('\n')}\n`);
          },
        },
      },
      `pagespace keys create${intent.flags.device ? ' --device' : ''}`,
    );

    if (result.outcome === 'failed') {
      ctx.stderr.write(`${result.message}\n`);
      return EXIT_RUNTIME_ERROR;
    }

    info.write(`Created key "${keyName}" on ${host}, scoped to: ${scopeResult.driveScope}.\n`);
    if (parsedArgs.args.showToken) {
      if (mintedToken !== null) {
        // The ONLY stdout line in --show-token mode (see `info` above).
        ctx.stdout.write(`${TOKEN_ENV_VAR_NAME}=${mintedToken}\n`);
        ctx.stderr.write("This token is shown once and never again. Anyone holding it gets this key's access.\n");
      } else {
        ctx.stderr.write('--show-token: no raw token to show — the server returned a refresh credential instead of a static token.\n');
      }
    }
    info.write(`${renderAgentWiringGuidance({ keyName, host }).join('\n')}\n`);
    return EXIT_SUCCESS;
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
  requestDeviceAuthorization: createRequestDeviceAuthorization(),
  pollDeviceToken: createPollDeviceToken(),
  isInterrupted: createSigintFlag(),
  now: Date.now,
});
