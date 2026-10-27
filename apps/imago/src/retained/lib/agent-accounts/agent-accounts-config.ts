/**
 * Whether this deployment configured agent accounts (G2): the credential plane's URL and service
 * secret, the executor's presenter key id and the grant-signing key are all present. Reads the
 * environment only — no database, no crypto — so the request-time tool filter can import it from a
 * module that client components also import (it is simply false in a browser bundle).
 */
export const PLANE_URL_ENV = 'AGENT_ACCOUNTS_PLANE_URL';
export const PLANE_SERVICE_SECRET_ENV = 'AGENT_ACCOUNTS_PLANE_SERVICE_SECRET';
export const PRESENTER_KEY_ID_ENV = 'AGENT_ACCOUNTS_PRESENTER_KEY_ID';

const present = (value: string | undefined) => (value?.trim() ?? '').length > 0;

export function isAgentAccountsConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return (
    present(env[PLANE_URL_ENV]) &&
    present(env[PLANE_SERVICE_SECRET_ENV]) &&
    present(env[PRESENTER_KEY_ID_ENV]) &&
    (present(env.ACCOUNT_AUTHORITY_SIGNING_KEY) || present(env.ACCOUNT_AUTHORITY_SIGNING_KEYS))
  );
}
