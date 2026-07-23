/**
 * `pagespace keys use <name>` / `pagespace keys use --off` — the per-machine
 * ACTIVE key. A human activates one stored key per host via a browser
 * approval (the `activate_key:<tokenId>` OAuth ceremony — consent verifies
 * ownership server-side and changes NOTHING; see `loopback-flow.ts`'s
 * `mcp_activate` handling); `run.ts` then lets gated content commands on
 * this machine fall back to that key when no `--token`/`--key`/env
 * credential is given. Explicit always wins, and `pagespace mcp` never uses
 * the active key at all.
 *
 * The activation itself is recorded LOCALLY (`credentials/active-key.ts` —
 * a non-secret host → name map): the ceremony mints nothing and stores no
 * credential, it only proves a human holding this host's login approved
 * activating exactly this key. `runActivateCeremony` is shared with the
 * wizard's "Set active key" menu item (`wizard.ts`), so the CLI form and the
 * guided form cannot drift.
 */
import { randomBytes } from 'node:crypto';
import { listMcpTokens } from '@pagespace/sdk';
import type { z } from 'zod';
import { PAGESPACE_CLI_CLIENT_ID } from '../../auth/client.js';
import { confirmIdentity } from '../../auth/confirm-identity.js';
import { createDiscoverMetadata } from '../../auth/discover.js';
import { createExchangeCode } from '../../auth/exchange-code.js';
import { createLoopbackServer } from '../../auth/create-loopback-server.js';
import { openBrowser } from '../../auth/open-browser.js';
import { unrefWaitMs } from '../../auth/wait.js';
import { createPollDeviceToken } from '../../auth/poll-device-token.js';
import { createRequestDeviceAuthorization } from '../../auth/request-device-authorization.js';
import { createSigintFlag } from '../../auth/sigint.js';
import { renderDeviceCodePrompt, runConsent } from '../../auth/run-consent.js';
import type { LoopbackLoginResult } from '../../auth/loopback-flow.js';
import { resolveConfig } from '../../config/resolve.js';
import { createCredentialStore } from '../../credentials/store.js';
import type { CredentialStore } from '../../credentials/store.js';
import { credentialSecret } from '../../credentials/serialize.js';
import type { HostCredential } from '../../credentials/serialize.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../../exit-codes.js';
import type { HandlerContext } from '../../handler-context.js';
import type { CommandHandler } from '../../router/router.js';
import { DEFAULT_LOGIN_TIMEOUT_MS, DEFAULT_MAX_PORT_ATTEMPTS } from '../login.js';
import { buildKeyActivateScope, type TokensCreateHandlerDeps } from './create.js';
import { parseKeysUseArgs } from './args.js';

type ServerKeySummaries = z.infer<typeof listMcpTokens.outputSchema>;

export function missingKeyMessage(name: string, host: string): string {
  return `No key named "${name}" is stored for ${host}. Run "pagespace keys" to create one.`;
}

export function loginCredentialNotActivatableMessage(name: string): string {
  return `"${name}" is a login credential, not an access key — only keys minted by "pagespace keys" can be activated.`;
}

export function revokedKeyMessage(name: string, host: string): string {
  return (
    `No key on ${host} matches "${name}" — it may have been revoked. ` +
    'Run "pagespace keys list" to see your keys, or mint a new one with "pagespace keys".'
  );
}

export function activationSuccessMessage(name: string, host: string): string {
  return (
    `"${name}" is now the active key for ${host}. Commands on this machine will use it unless ` +
    '--key/PAGESPACE_KEY/--token override it. Run "pagespace keys use --off" to deactivate.'
  );
}

export function deactivationMessage(host: string): string {
  return `Active key cleared for ${host}. Content commands on this machine now require an explicit credential again.`;
}

/** The minimal server-key shape `findServerTokenId` matches against — both `listMcpTokens` rows and the wizard's `KeySummary` satisfy it. */
export interface ServerKeyRef {
  readonly id: string;
  readonly tokenPrefix: string;
}

/**
 * Finds the server-side token row backing a locally stored static
 * credential: the row whose `tokenPrefix` is a prefix of the stored token.
 * Pure; `null` when nothing matches (revoked, or minted against a different
 * account).
 */
export function findServerTokenId(keys: readonly ServerKeyRef[], credential: HostCredential): string | null {
  const secret = credentialSecret(credential);
  const match = keys.find((key) => secret.startsWith(key.tokenPrefix));
  return match?.id ?? null;
}

/** Mirrors `keys create`'s outcome-to-message mapping as plain strings — the ceremony's callers render them. */
export function describeActivateFailure(result: Exclude<LoopbackLoginResult, { outcome: 'success' }>): string {
  switch (result.outcome) {
    case 'timeout':
      return 'Approval timed out waiting for the browser redirect. Run "pagespace keys use" again.';
    case 'state_mismatch':
      return 'Approval failed: the authorization response did not match this request. Run "pagespace keys use" again.';
    case 'access_denied':
      return 'Approval was denied.';
    case 'authorize_error':
      return `Approval failed: ${result.error}`;
    case 'token_exchange_failed':
      return `Approval failed while exchanging the authorization code: ${result.message}`;
    case 'port_bind_failed':
      return 'Could not bind a local loopback port to receive the approval redirect.';
    case 'discovery_failed':
      return `Could not discover the OAuth server configuration: ${result.message}`;
    default: {
      const unreachable: never = result;
      throw new Error(`Unhandled approval outcome: ${JSON.stringify(unreachable)}`);
    }
  }
}

export interface ActivateCeremonyParams {
  readonly host: string;
  /** The LOCAL credential name to record as active on success. */
  readonly name: string;
  /** The server-side key id (`mcp_tokens` row) the human is approving. */
  readonly tokenId: string;
  /**
   * Passed to `runLoopbackLogin` as its `credentialStore` — the flow
   * persists NOTHING for an `activate_key` grant (and fails closed if the
   * server answers with a surprise mint), so no write ever reaches it.
   */
  readonly store: CredentialStore;
  readonly onBrowserOpenFailed: (url: string) => void;
  /** True when `--device` was passed: print a verification code instead of opening a browser. */
  readonly device?: boolean;
  /** Where to print the device verification lines (the wizard routes these around its spinner). */
  readonly onDeviceCode?: (lines: string[]) => void;
}

export type ActivateCeremonyResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

/**
 * The browser-approval core shared by `keys use <name>` and the wizard's
 * "Set active key": run the `activate_key:<tokenId>` consent, verify the
 * server approved exactly that key, then record the activation locally via
 * `ctx.activeKeyStore`. Nothing is persisted to the credential store on any
 * path (see `ActivateCeremonyParams.store`).
 */
export async function runActivateCeremony(
  ctx: HandlerContext,
  deps: TokensCreateHandlerDeps,
  params: ActivateCeremonyParams,
): Promise<ActivateCeremonyResult> {
  const scopeResult = buildKeyActivateScope(params.tokenId);
  if (!scopeResult.ok) {
    return { ok: false, message: scopeResult.message };
  }

  const device = params.device ?? false;
  const result = await runConsent(
    {
      device,
      host: params.host,
      clientId: PAGESPACE_CLI_CLIENT_ID,
      scope: scopeResult.scope,
      discoverMetadata: deps.discoverMetadata,
      exchangeCode: deps.exchangeCode,
      confirmIdentity: deps.confirmIdentity,
      credentialStore: params.store,
      waitMs: deps.waitMs,
      now: deps.now,
      timeoutMs: deps.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS,
      // Defense-in-depth sentinel only: both flows persist nothing for an
      // activate_key grant and fail closed on a surprise mint, so this name is
      // never written — but if it ever were, it must not be a real slot.
      profile: `activate-${params.tokenId}`,
      loopback: {
        randomBytes: deps.randomBytes,
        startServer: deps.startServer,
        openBrowser: deps.openBrowser,
        maxPortAttempts: deps.maxPortAttempts ?? DEFAULT_MAX_PORT_ATTEMPTS,
        onBrowserOpenFailed: params.onBrowserOpenFailed,
      },
      deviceDeps: {
        requestDeviceAuthorization: deps.requestDeviceAuthorization,
        pollDeviceToken: deps.pollDeviceToken,
        isInterrupted: deps.isInterrupted,
        onDeviceCode: (authorization) => {
          params.onDeviceCode?.(renderDeviceCodePrompt(authorization));
        },
      },
    },
    `pagespace keys use${device ? ' --device' : ''}`,
  );

  if (result.outcome === 'failed') {
    return { ok: false, message: result.message };
  }

  // Fail closed unless the server approved EXACTLY the key this ceremony
  // named — a success without `activatedTokenId` means the server answered
  // with something other than an activation approval (nothing was stored
  // either way; runLoopbackLogin's own guard already rejected any surprise
  // mint), and recording an activation the server didn't approve would lie
  // about what a human consented to.
  if (result.activatedTokenId !== params.tokenId) {
    return {
      ok: false,
      message: 'The server approved a different key than this activation named — nothing was activated. Run "pagespace keys list" to verify your keys.',
    };
  }

  try {
    await ctx.activeKeyStore.setActiveKey(params.host, params.name);
  } catch (error) {
    return {
      ok: false,
      message: `Could not record the active key locally: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return { ok: true };
}

export function createKeysUseHandler(deps: TokensCreateHandlerDeps): CommandHandler {
  return async (ctx, intent) => {
    const parsed = parseKeysUseArgs(intent.args);
    if (!parsed.ok) {
      ctx.stderr.write(`${parsed.message}\n`);
      return EXIT_USAGE_ERROR;
    }

    const { host } = resolveConfig({
      flags: { host: intent.flags.host },
      env: { PAGESPACE_API_URL: ctx.env.PAGESPACE_API_URL },
      credential: null,
    });

    if (parsed.args.kind === 'off') {
      try {
        await ctx.activeKeyStore.clearActiveKey(host);
      } catch (error) {
        ctx.stderr.write(`Could not clear the active key: ${error instanceof Error ? error.message : String(error)}\n`);
        return EXIT_RUNTIME_ERROR;
      }
      ctx.stdout.write(`${deactivationMessage(host)}\n`);
      return EXIT_SUCCESS;
    }

    const { name } = parsed.args;
    const store = deps.createCredentialStore();
    const credential = await store.get(host, name);
    if (credential === null) {
      ctx.stderr.write(`${missingKeyMessage(name, host)}\n`);
      return EXIT_USAGE_ERROR;
    }
    if (credential.kind === 'oauth') {
      ctx.stderr.write(`${loginCredentialNotActivatableMessage(name)}\n`);
      return EXIT_USAGE_ERROR;
    }

    // Resolve the server-side key id backing this stored token — via
    // `ctx.sdk` exactly like `keys list` (the keys family's ambient
    // manage_keys login credential; run.ts exempts this handler from the
    // explicit-credential gate for the same reason it exempts `keys list`).
    let serverKeys: ServerKeySummaries;
    try {
      serverKeys = await ctx.sdk.invoke(listMcpTokens, {});
    } catch (error) {
      ctx.stderr.write(`Could not look up "${name}" on ${host}: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_RUNTIME_ERROR;
    }

    const tokenId = findServerTokenId(serverKeys, credential);
    if (tokenId === null) {
      ctx.stderr.write(`${revokedKeyMessage(name, host)}\n`);
      return EXIT_RUNTIME_ERROR;
    }

    if (!intent.flags.device) {
      ctx.stdout.write(`Opening your browser to approve activating "${name}" on ${host}...\n`);
    }

    const result = await runActivateCeremony(ctx, deps, {
      host,
      name,
      tokenId,
      store,
      onBrowserOpenFailed: (url) => {
        ctx.stderr.write(`Could not open a browser automatically. Open this URL to continue:\n${url}\n`);
      },
      device: intent.flags.device,
      onDeviceCode: (lines) => {
        ctx.stdout.write(`${lines.join('\n')}\n`);
      },
    });

    if (!result.ok) {
      ctx.stderr.write(`${result.message}\n`);
      return EXIT_RUNTIME_ERROR;
    }

    ctx.stdout.write(`${activationSuccessMessage(name, host)}\n`);
    return EXIT_SUCCESS;
  };
}

function nodeRandomBytes(length: number): Uint8Array {
  return new Uint8Array(randomBytes(length));
}

export const keysUseHandler: CommandHandler = createKeysUseHandler({
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
