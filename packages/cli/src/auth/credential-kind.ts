/**
 * What CLASS of credential this invocation resolved — the one question
 * `AuthSource` already answers but no command could ask without also getting
 * hold of the secret.
 *
 * `keys list`/`revoke`/`use` and the wizard all reach the key-MANAGEMENT API,
 * which admits only a full-user credential: enumerating or revoking every key
 * a person holds is not something one scoped key should be able to do to the
 * others, so `GET/POST/DELETE /api/auth/mcp-tokens` refuse `mcp_` tokens by
 * design. A scoped key hitting them therefore gets a refusal it can do nothing
 * about — and, before this, a refusal that said the KEY was invalidated when it
 * was working fine on every other route (issue #2464).
 *
 * The precedent is `whoami`, which faces the same wall at `/api/auth/me` and
 * answers the honest question for a scoped key instead of asking one the
 * server will never answer (see `auth/probe-drives.ts`). This module is what
 * lets the `keys` family do the same: classify first, then say something true.
 *
 * PURE, and deliberately secret-free in its OUTPUT — `run.ts` puts only the
 * resulting label on `HandlerContext`, never the `AuthSource` itself, so a
 * command cannot reach a bearer token through it.
 */
import type { AuthSource } from './resolve.js';

/**
 * - `key`   — a scoped access key (`mcp_*`), from `--token`/env or a stored
 *             `static` credential. Reads and writes drive content; cannot
 *             manage keys.
 * - `login` — a personal login credential (`pagespace login`), which is what
 *             the key-management surface wants.
 * - `other` — a bearer given as `--token`/env that is neither: an OAuth access
 *             token pasted by hand, or something this CLI has no name for.
 *             Never assumed to be a key, so it is never pre-emptively refused.
 * - `none`  — nothing resolved at all.
 */
export type CredentialKind = 'key' | 'login' | 'other' | 'none';

/** The wire prefix every scoped access key carries (`apps/web/src/lib/auth/token-prefixes.ts`). */
const KEY_TOKEN_PREFIX = 'mcp_';

/** Pure: no I/O. Never returns the token it inspected. */
export function credentialKindOf(source: AuthSource): CredentialKind {
  switch (source.kind) {
    case 'flag':
    case 'env':
      return source.token.startsWith(KEY_TOKEN_PREFIX) ? 'key' : 'other';
    case 'stored':
      return source.credential.kind === 'static' ? 'key' : 'login';
    case 'none':
      return 'none';
  }
}

/**
 * What `pagespace keys <verb>` says when the resolved credential is a scoped
 * key rather than a login.
 *
 * Three things it must do, and one it must NOT.
 *
 * It says this refusal is not evidence about the key, names the real
 * limitation, and gives the commands that get the caller somewhere. What it
 * deliberately does not say is that the key is VALID: nothing has been
 * validated at this point — the classification is a prefix check on a
 * credential no request has yet been made with, so a revoked token would
 * reach exactly this branch too. The bug being fixed was an unearned claim in
 * the other direction ("Static token was invalidated"), and replacing it with
 * an equally unearned claim would only move the lie. `keys describe` is
 * offered for every verb because it is both the question a key CAN ask about
 * itself and the call that would actually prove the key still works.
 *
 * The login line carries the precedence caveat because without it the advice
 * misfires in the exact case that motivated this message: `pagespace login`
 * stores a personal credential, but an explicit `--token`/env credential
 * outranks it (`auth/resolve.ts`), so an agent with the key still in its
 * environment would log in and hit this same refusal again.
 */
export function keysCommandNeedsLoginMessage(verb?: string): string {
  const command = verb === undefined ? 'pagespace keys' : `pagespace keys ${verb}`;
  return (
    `"${command}" needs your personal login, and this invocation resolved a scoped access key.\n` +
    'That says nothing about the key: key management is simply not something a key can do. A key reads and writes ' +
    'drive content, while listing, minting and revoking keys is reserved for the person who owns them.\n' +
    '  pagespace keys describe   — what THIS key is, and the permissions it actually resolves to\n' +
    `  pagespace login           — then re-run "${command}" with the key's --token/env credential removed,\n` +
    '                              since an explicit credential outranks your stored login.'
  );
}
