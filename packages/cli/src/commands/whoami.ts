/**
 * `pagespace whoami [--host <url>] [--key <name>] [--token <token>] [--json]`.
 *
 * Reports the credential THIS INVOCATION WOULD ACTUALLY USE, resolved through
 * the one shared precedence resolver (`auth/resolve-credential-source.ts`,
 * where the chain — token flag, then token env var, then the named key, then
 * this machine's active key from `pagespace keys use`, then the stored
 * `"default"` login credential — is spelled out). It previously looked only at
 * that LAST link, so a machine whose every content command worked through an
 * active key was told "Not logged in" — the credential it reported on was not
 * the credential it would have used.
 *
 * The env-var NAMES are deliberately not written out anywhere in this file:
 * `commands/__tests__/single-auth-path.test.ts` greps every command module for
 * those literals so no command can grow its own env read, and display copy
 * naming them would blunt that tripwire. `TOKEN_ENV_VAR_NAME` is interpolated
 * instead (see `auth/resolve.ts`).
 *
 * Two kinds of credential, two honest questions:
 *
 * - An `oauth`-kind (personal login) credential caches no access token between
 *   invocations, so `whoami` performs one refresh_token grant to mint a fresh
 *   one, then asks `/api/auth/me` who it belongs to. Persist-before-use (ADR
 *   0003 §3.5): the rotated refresh token is written to the credential store
 *   BEFORE the new access token is used, so a crash between refresh and
 *   identity confirmation never strands a rotated-away token.
 * - A `static`-kind (`mcp_*`) key has no refresh cycle and no "current user":
 *   `/api/auth/me` deliberately refuses it (see `auth/probe-drives.ts`).
 *   Asking it for an identity could only ever fail — which is exactly what it
 *   used to do, reporting a live key as invalidated. Its stored scopes ARE the
 *   current grant, so `whoami` reports those and proves the key still works
 *   with a `drives.list` probe instead.
 *
 * Non-interactive: a missing credential exits 1 immediately, never prompting —
 * safe in CI/non-TTY.
 */
import { resolveConfig } from '../config/resolve.js';
import { createCredentialStore } from '../credentials/store.js';
import type { CredentialStore } from '../credentials/store.js';
import { credentialSecret, DEFAULT_PROFILE_NAME, tokenPrefix } from '../credentials/serialize.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS } from '../exit-codes.js';
import type { CommandHandler } from '../router/router.js';
import { confirmIdentity } from '../auth/confirm-identity.js';
import { createDiscoverMetadata } from '../auth/discover.js';
import type { ConfirmIdentity, DiscoverMetadata, Identity } from '../auth/loopback-flow.js';
import { probeDriveCount, type ProbeDriveCount } from '../auth/probe-drives.js';
import { describeCredentialSource, resolveCredentialSource } from '../auth/resolve-credential-source.js';
import { TOKEN_ENV_VAR_NAME } from '../auth/resolve.js';
import { createRefreshAccessToken } from '../auth/silent-refresh.js';
import { exchangeAgentAssertion } from '@pagespace/sdk';
import type { OAuthTokens, RefreshAccessToken } from '@pagespace/sdk';
import { agentCredentialWithTokens, createAgentRefreshAccessToken } from '../auth/agent-session.js';
import { fetchAccountProfile, type AccountProfile, type FetchAccountProfile } from '../auth/agent-profile.js';
import type { AgentHostCredential } from '../credentials/serialize.js';

export interface WhoamiHandlerDeps {
  readonly createCredentialStore: () => CredentialStore;
  readonly discoverMetadata: DiscoverMetadata;
  readonly createRefreshAccessToken: (tokenEndpoint: string, clientId: string) => RefreshAccessToken;
  readonly confirmIdentity: ConfirmIdentity;
  readonly probeDriveCount: ProbeDriveCount;
  readonly now: () => number;
  /** The jwt-bearer exchange of an agent secret (ADR 0008); the SDK's by default. */
  readonly exchangeAgentAssertion?: (tokenEndpoint: string, secret: string, clientId: string) => Promise<OAuthTokens>;
  /** `/api/auth/me` with the account type and owner; the real call by default. */
  readonly fetchAccountProfile?: FetchAccountProfile;
}

/** What `whoami` reports about an AI agent's own account (ADR 0008). */
interface AgentReport {
  readonly agentId: string;
  readonly name: string | null;
  readonly ownerUserId: string | null;
  readonly claimedAt: string | null;
  readonly source: string | null;
}

/**
 * Asks the server who the stored AGENT credential is, and whether anyone owns
 * it: refresh (re-exchanging the secret on invalid_grant, `agent-session.ts`),
 * persist the rotated refresh token BEFORE using the new access token, then
 * `/api/auth/me`. Never deletes the credential.
 */
async function reportAgent(
  deps: WhoamiHandlerDeps,
  store: CredentialStore,
  host: string,
  profile: string,
  credential: AgentHostCredential,
): Promise<{ readonly ok: true; readonly report: AgentReport } | { readonly ok: false; readonly message: string }> {
  let tokens: OAuthTokens;
  try {
    const { tokenEndpoint } = await deps.discoverMetadata(host);
    const exchange =
      deps.exchangeAgentAssertion ?? ((endpoint: string, secret: string, clientId: string) => exchangeAgentAssertion(endpoint, secret, clientId));
    tokens = await createAgentRefreshAccessToken({
      secret: credential.secret,
      refresh: (refreshToken) => deps.createRefreshAccessToken(tokenEndpoint, credential.clientId)(refreshToken),
      exchange: (secret) => exchange(tokenEndpoint, secret, credential.clientId),
    })(credential.refreshToken ?? '');
  } catch (error) {
    return { ok: false, message: `the agent credential was refused (${messageOf(error)}); if its secret was rotated elsewhere, pipe the new one to "pagespace login --agent --yes"` };
  }
  await store.set(host, agentCredentialWithTokens(credential, tokens, deps.now()), profile);

  let profileInfo: AccountProfile;
  try {
    profileInfo = await (deps.fetchAccountProfile ?? fetchAccountProfile)({ host, accessToken: tokens.accessToken });
  } catch (error) {
    return { ok: false, message: `could not read the agent's account: ${messageOf(error)}` };
  }
  return {
    ok: true,
    report: {
      agentId: profileInfo.id,
      name: profileInfo.name,
      ownerUserId: profileInfo.agent?.ownerUserId ?? null,
      claimedAt: profileInfo.agent?.claimedAt ?? null,
      source: profileInfo.agent?.source ?? null,
    },
  };
}

function agentLines(report: AgentReport): string[] {
  return [
    'Account: AI agent',
    `Agent:  ${report.name ?? 'Agent'} (${report.agentId})`,
    report.ownerUserId === null
      ? 'Owner:  Unclaimed — no AI credits until a human claims you; run "pagespace agent claim"'
      : `Owner:  ${report.ownerUserId} (claimed${report.claimedAt ? ` ${report.claimedAt}` : ''}; your AI usage bills them)`,
  ];
}

/** `mcp_*` tokens are scoped keys, not OAuth access tokens — see `auth/probe-drives.ts`. */
function isScopedKeyToken(token: string): boolean {
  return token.startsWith('mcp_');
}

/**
 * Display-only: drop the `name:<percent-encoded>` wire token from a scope
 * list. It is a mint-request parameter that rides along in the granted scope
 * (see `commands/keys/create.ts`'s `buildTokenScope`), not an access grant —
 * printing it in a line headed "Scopes:" reads as though the key can do
 * something called "name:ALL". `--json` keeps the stored scope array verbatim:
 * a machine reader wants what was actually persisted, not a prettied subset.
 */
function displayScopes(scopes: readonly string[]): string[] {
  return scopes.filter((scope) => !scope.startsWith('name:'));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createWhoamiHandler(deps: WhoamiHandlerDeps): CommandHandler {
  return async (ctx, intent) => {
    const { host } = resolveConfig({
      flags: { host: intent.flags.host },
      env: { PAGESPACE_API_URL: ctx.env.PAGESPACE_API_URL },
      credential: null,
    });

    const store = deps.createCredentialStore();
    const resolved = await resolveCredentialSource({
      flags: { token: intent.flags.token, key: intent.flags.key },
      env: ctx.env,
      host,
      credentialStore: store,
      // Unlike every other auth-exempt handler, whoami's whole job is
      // reporting what a content command on this machine would authenticate
      // as — so it must see the active key that `run.ts` withholds from the
      // `keys` family (which needs a `manage_keys` scope no drive-scoped
      // active key carries).
      activeKeyStore: ctx.activeKeyStore,
      allowActiveKey: true,
    });
    const { source } = resolved;

    if (source.kind === 'none') {
      // Name the source the user actually reached for. An explicit `--key`
      // suppresses the active key entirely, so blaming a dangling active key
      // there would send them to fix something this invocation never consulted.
      if (resolved.explicit) {
        ctx.stderr.write(
          `No credential stored for ${host} under key "${resolved.keyName}". List what is stored with "pagespace keys list", or mint it with "pagespace keys create".\n`,
        );
        return EXIT_RUNTIME_ERROR;
      }
      const active = await ctx.activeKeyStore.getActiveKey(host);
      ctx.stderr.write(
        active === null
          ? `No credential resolved for ${host}: no stored login, and no active key set on this machine. Run "pagespace login", then "pagespace keys create" and "pagespace keys use <name>".\n`
          : `No credential resolved for ${host}: the active key "${active}" has no stored credential on this machine. Re-mint it with "pagespace keys create", or pick another with "pagespace keys use <name>".\n`,
      );
      return EXIT_RUNTIME_ERROR;
    }

    // Rendered on every report except the one where it IS the subject: knowing
    // whether a personal login exists separately from the key in use is what
    // makes the "content commands work but `keys list` says no credentials"
    // state legible.
    const personalLogin =
      source.kind === 'stored' && resolved.keyName === DEFAULT_PROFILE_NAME
        ? null
        : (await store.get(host, DEFAULT_PROFILE_NAME)) !== null;

    // An AI agent's own account (ADR 0008): the stored login is the agent
    // itself. Report the account type and owner whatever credential resolved —
    // after `signup --agent` that is usually the agent's own active key, which
    // `/api/auth/me` cannot speak for.
    const loginForAgent =
      source.kind === 'stored' && source.credential.kind === 'agent'
        ? { profile: resolved.keyName, credential: source.credential }
        : await (async () => {
            const stored = await store.get(host, DEFAULT_PROFILE_NAME);
            return stored !== null && stored.kind === 'agent' ? { profile: DEFAULT_PROFILE_NAME, credential: stored } : null;
          })();
    let agent: AgentReport | null = null;
    if (loginForAgent !== null) {
      const result = await reportAgent(deps, store, host, loginForAgent.profile, loginForAgent.credential);
      if (!result.ok) {
        ctx.stderr.write(`Could not confirm the agent account on ${host}: ${result.message}\n`);
        return EXIT_RUNTIME_ERROR;
      }
      agent = result.report;
    }

    const sourceLabel = describeCredentialSource(resolved, TOKEN_ENV_VAR_NAME);
    let identity: Identity | null = null;
    let scopes: readonly string[] | null = null;
    let driveCount: number | null = null;
    let secret: string;
    /**
     * Shown only for a long-lived bearer key, where a prefix is the key's
     * stable identifier and matches what `pagespace keys list` prints. The
     * oauth path deliberately leaves this null: its `secret` is an access
     * token minted seconds ago by this very command, so a prefix of it
     * identifies nothing a reader could act on and is one more place for a
     * live token fragment to land in a terminal scrollback or CI log.
     */
    let shownTokenPrefix: string | null = null;

    if (source.kind === 'stored' && source.credential.kind === 'agent') {
      // Reported above: the account token has `account offline_access` and no
      // drives; its live scope is what the refresh just returned.
      scopes = source.credential.scopes;
    } else if (source.kind === 'stored' && source.credential.kind === 'oauth') {
      const credential = source.credential;
      let tokenEndpoint: string;
      try {
        tokenEndpoint = (await deps.discoverMetadata(host)).tokenEndpoint;
      } catch (error) {
        ctx.stderr.write(`Could not confirm identity on ${host}: ${messageOf(error)}\n`);
        return EXIT_RUNTIME_ERROR;
      }

      let tokens;
      try {
        const doRefresh = deps.createRefreshAccessToken(tokenEndpoint, credential.clientId);
        tokens = await doRefresh(credential.refreshToken);
      } catch {
        ctx.stderr.write(`Not logged in to ${host}: stored credential was rejected. Run "pagespace login" again.\n`);
        return EXIT_RUNTIME_ERROR;
      }

      // Prefer the server's live, authoritative scope from this refresh over
      // the locally-cached value — whoami exists to confirm CURRENT grants,
      // and a refresh response scope reflects any server-side
      // narrowing/change since the credential was last stored. Fall back to
      // the stored scopes only if the transport didn't capture one.
      scopes = tokens.scope !== undefined ? tokens.scope.split(' ').filter(Boolean) : credential.scopes;
      await store.set(
        host,
        {
          kind: 'oauth',
          refreshToken: tokens.refreshToken,
          clientId: credential.clientId,
          scopes,
          createdAt: new Date(deps.now()).toISOString(),
        },
        resolved.keyName,
      );
      secret = tokens.accessToken;

      try {
        identity = await deps.confirmIdentity({ host, accessToken: secret });
      } catch (error) {
        ctx.stderr.write(`Could not confirm identity on ${host}: ${messageOf(error)}\n`);
        return EXIT_RUNTIME_ERROR;
      }
    } else {
      // Everything else is a bearer secret used exactly as given: a stored
      // `static` key, or a `--token`/env token whose kind isn't knowable from
      // disk. An `mcp_*` prefix skips the identity call outright (it could
      // only 401); anything else is tried as an OAuth access token first and
      // falls through to the drives probe when the server won't speak for it.
      if (source.kind === 'stored') {
        // `credentialSecret` reads whichever field carries the bearer for this
        // credential kind, so a future third kind is its problem to handle
        // rather than a new branch to remember here. Stored scopes are only
        // meaningful for a static key — an oauth credential took the branch
        // above.
        secret = credentialSecret(source.credential);
        scopes = source.credential.kind === 'static' ? source.credential.scopes : null;
      } else {
        secret = source.token;
        scopes = null;
      }
      shownTokenPrefix = tokenPrefix(secret);

      // Concurrent, not sequential: neither call feeds the other, and this is
      // an interactive status command — serializing them would double its
      // latency for no gain. Each carries its own failure, so neither can fail
      // the other.
      const [resolvedIdentity, probe] = await Promise.all([
        // Nothing to ask for an `mcp_*` key — `/api/auth/me` refuses it by
        // design (see `auth/probe-drives.ts`). Any other token is tried, and a
        // server that won't speak for it simply yields null.
        isScopedKeyToken(secret)
          ? Promise.resolve(null)
          : deps.confirmIdentity({ host, accessToken: secret }).catch(() => null),
        deps
          .probeDriveCount({ host, accessToken: secret })
          .then((count) => ({ ok: true as const, count }))
          .catch((error: unknown) => ({ ok: false as const, error })),
      ]);

      identity = resolvedIdentity;

      if (probe.ok) {
        driveCount = probe.count;
      } else if (identity === null) {
        // A rejected probe is only fatal when nothing else vouched for the
        // credential: an OAuth access token that `/api/auth/me` already
        // answered for is live regardless of whether its scope reaches drives.
        ctx.stderr.write(
          `The credential resolved for ${host} (${sourceLabel}) was rejected: ${messageOf(probe.error)}\n` +
            'Re-mint it with "pagespace keys create" (or "pagespace keys" for the guided wizard).\n',
        );
        return EXIT_RUNTIME_ERROR;
      }
    }

    if (intent.flags.json) {
      ctx.stdout.write(
        `${JSON.stringify({
          host,
          name: identity?.name ?? null,
          email: identity?.email ?? null,
          scopes: scopes ?? [],
          activeKey: resolved.activeKeyName,
          source: source.kind,
          sourceLabel,
          keyName: source.kind === 'stored' ? resolved.keyName : null,
          tokenPrefix: shownTokenPrefix,
          driveCount,
          personalLogin,
          ...(agent === null
            ? {}
            : {
                accountType: 'agent',
                agent: { id: agent.agentId, name: agent.name, ownerUserId: agent.ownerUserId, claimed: agent.ownerUserId !== null, claimedAt: agent.claimedAt, source: agent.source },
              }),
        })}\n`,
      );
      return EXIT_SUCCESS;
    }

    ctx.stdout.write(`Host:   ${host}\n`);
    ctx.stdout.write(`Source: ${sourceLabel}${shownTokenPrefix === null ? '' : ` (${shownTokenPrefix}…)`}\n`);
    if (identity !== null) {
      ctx.stdout.write(`User:   ${identity.name ?? identity.email} <${identity.email}>\n`);
    }
    const shownScopes = scopes === null ? null : displayScopes(scopes);
    ctx.stdout.write(
      `Scopes: ${shownScopes === null ? '(not stored locally)' : shownScopes.length > 0 ? shownScopes.join(' ') : '(none)'}\n`,
    );
    if (driveCount !== null) {
      ctx.stdout.write(`Drives: ${driveCount} accessible\n`);
    }
    if (agent !== null) {
      ctx.stdout.write(`${agentLines(agent).join('\n')}\n`);
    } else if (personalLogin !== null) {
      ctx.stdout.write(personalLogin ? 'Personal login: present\n' : 'Personal login: none (run "pagespace login")\n');
    }

    return EXIT_SUCCESS;
  };
}

export const whoamiHandler: CommandHandler = createWhoamiHandler({
  createCredentialStore,
  discoverMetadata: createDiscoverMetadata(),
  createRefreshAccessToken,
  confirmIdentity,
  probeDriveCount,
  now: Date.now,
});
