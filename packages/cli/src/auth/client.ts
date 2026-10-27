/**
 * The CLI's own OAuth client identity. Inlined (not imported from
 * `@pagespace/lib/auth/oauth/clients`) so the published CLI never
 * runtime-imports `@pagespace/lib` — see `credentials/keychain.ts` and
 * `../../sdk/src/operations/roles.ts`'s `PagePerm` for the same reasoning.
 *
 * Structural/value drift against the OAuth provider's own registration
 * (`packages/lib/src/auth/oauth/clients.ts`, `PAGESPACE_CLI_CLIENT_ID`) is
 * caught by `__tests__/client.test.ts`, a devDependency-only test import of
 * `@pagespace/lib` (never shipped in `dist`).
 */
export const PAGESPACE_CLI_CLIENT_ID = 'pagespace-cli';
