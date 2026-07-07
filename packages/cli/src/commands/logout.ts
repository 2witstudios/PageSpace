/**
 * `pagespace logout [--host <url>] [--all] [--force]` (Phase 4 task 5).
 * Zero-trust ordering: revokes the refresh token server-side via
 * `/api/oauth/revoke` (RFC 7009, killing the whole rotation family per
 * Phase 1 task 10) BEFORE deleting the local credential — deleting first
 * would leave a live, unrevoked token sitting in backups/swap. A transient
 * revoke failure never deletes the local credential unless `--force` is
 * given; the user is told plainly that server-side revocation did not
 * happen. `--all` iterates every stored profile, continuing on individual
 * failures and reporting per-host outcomes.
 *
 * Constructs its own `CredentialStore` rather than reading
 * `ctx.credentialStore` (still the single-profile placeholder pending
 * Phase 4 task 7), matching `pagespace login`'s convention.
 */
import { resolveConfig } from '../config/resolve.js';
import { createCredentialStore } from '../credentials/store.js';
import type { CredentialStore } from '../credentials/store.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS } from '../exit-codes.js';
import type { ExitCode } from '../exit-codes.js';
import type { CommandHandler } from '../router/router.js';
import { createRevokeToken } from '../auth/revoke-token.js';
import type { RevokeToken } from '../auth/revoke-token.js';
import { resolveProfileName } from '../auth/resolve.js';

export type LogoutHostOutcome =
  | { readonly host: string; readonly kind: 'not_logged_in' }
  | { readonly host: string; readonly kind: 'revoked' }
  | { readonly host: string; readonly kind: 'forced'; readonly reason: string }
  | { readonly host: string; readonly kind: 'revoke_failed'; readonly reason: string };

export interface LogoutHandlerDeps {
  readonly createCredentialStore: () => CredentialStore;
  readonly revokeToken: RevokeToken;
}

/** Pure: no I/O. One human-readable line per host outcome. */
export function formatLogoutLine(outcome: LogoutHostOutcome): string {
  switch (outcome.kind) {
    case 'not_logged_in':
      return `Not logged in to ${outcome.host}.`;
    case 'revoked':
      return `Logged out of ${outcome.host}.`;
    case 'forced':
      return `Logged out of ${outcome.host} (--force: server-side revocation failed: ${outcome.reason}; local credential removed anyway).`;
    case 'revoke_failed':
      return (
        `Could not log out of ${outcome.host}: server-side revocation failed (${outcome.reason}). ` +
        'The local credential was NOT removed. Re-run with --force to remove it anyway, or try again.'
      );
    default: {
      const unreachable: never = outcome;
      throw new Error(`Unhandled logout outcome: ${JSON.stringify(unreachable)}`);
    }
  }
}

/** Pure: no I/O. Fails iff at least one host's revocation failed without --force. */
export function summarizeLogout(outcomes: readonly LogoutHostOutcome[]): ExitCode {
  return outcomes.some((outcome) => outcome.kind === 'revoke_failed') ? EXIT_RUNTIME_ERROR : EXIT_SUCCESS;
}

async function logoutHost(
  host: string,
  store: CredentialStore,
  revokeToken: RevokeToken,
  force: boolean,
  profile: string,
): Promise<LogoutHostOutcome> {
  const credential = await store.get(host, profile);
  if (!credential) {
    return { host, kind: 'not_logged_in' };
  }

  // A static (mcp) credential has no OAuth refresh-token family for
  // /api/oauth/revoke to revoke — it's a real mcp_* token, the same entity
  // `pagespace keys revoke <id>` (or Settings > MCP) manages. Logging out of
  // it just forgets the local credential; the key itself stays valid until
  // explicitly revoked through one of those surfaces — the same relationship
  // a personal login session has to a portable Settings > MCP token today.
  if (credential.kind === 'static') {
    await store.delete(host, profile);
    return { host, kind: 'revoked' };
  }

  const result = await revokeToken({ host, refreshToken: credential.refreshToken, clientId: credential.clientId });

  if (result.outcome === 'revoked') {
    await store.delete(host, profile);
    return { host, kind: 'revoked' };
  }

  if (force) {
    await store.delete(host, profile);
    return { host, kind: 'forced', reason: result.message };
  }

  return { host, kind: 'revoke_failed', reason: result.message };
}

export function createLogoutHandler(deps: LogoutHandlerDeps): CommandHandler {
  return async (ctx, intent) => {
    const { host } = resolveConfig({
      flags: { host: intent.flags.host },
      env: { PAGESPACE_API_URL: ctx.env.PAGESPACE_API_URL },
      profile: null,
    });
    const profileName = resolveProfileName(
      { profile: intent.flags.profile },
      { PAGESPACE_PROFILE: ctx.env.PAGESPACE_PROFILE },
    );

    const store = deps.createCredentialStore();
    const hosts = intent.flags.all ? (await store.list(profileName)).map((summary) => summary.host) : [host];

    if (hosts.length === 0) {
      ctx.stdout.write('No stored credentials to log out of.\n');
      return EXIT_SUCCESS;
    }

    const outcomes: LogoutHostOutcome[] = [];
    for (const target of hosts) {
      outcomes.push(await logoutHost(target, store, deps.revokeToken, intent.flags.force, profileName));
    }

    for (const outcome of outcomes) {
      const line = `${formatLogoutLine(outcome)}\n`;
      if (outcome.kind === 'revoke_failed') ctx.stderr.write(line);
      else ctx.stdout.write(line);
    }

    return summarizeLogout(outcomes);
  };
}

export const logoutHandler: CommandHandler = createLogoutHandler({
  createCredentialStore,
  revokeToken: createRevokeToken(),
});
