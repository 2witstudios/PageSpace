/**
 * The web process's handle on the agent-account authority (L2·G2). Wiring
 * only: it reads the four variables the web process is allowed to hold —
 * the plane's URL and service secret, the executor's presenter key id and the
 * grant-signing key — and builds `createAccountAuthority` once.
 *
 * It holds NO store identity and cannot reach material: the plane client has
 * no read route (ADR 0005 §3.4). When any variable is absent the feature is
 * simply off (`null`): routes answer 503 and the `http_request` tool is not
 * offered. A malformed signing key is also "off", never a fallback key.
 */
import { createHash } from 'node:crypto';
import { createAccountAuthority, type AccountAuthority } from '@pagespace/lib/agent-accounts/account-authority-executor';
import { createAgentAccountRepository } from '@pagespace/lib/agent-accounts/agent-account-repository';
import { createAccountFactsRepository } from '@pagespace/lib/agent-accounts/account-facts-repository';
import { createPlaneClient, PLANE_SERVICE_SECRET_VAR, PLANE_URL_VAR } from '@pagespace/lib/agent-accounts/plane-client';
import { isAgentAccountsConfigured, PRESENTER_KEY_ID_ENV } from './agent-accounts-config';
import { loadAccountAuthorityKeyring } from '@pagespace/lib/auth/account-authority-signing-key';
import type { PresenterKeyId } from '@pagespace/lib/agent-accounts/grant';
import { db } from '@pagespace/db/db';

let cached: AccountAuthority | null | undefined;

export function getAccountAuthority(): AccountAuthority | null {
  if (cached !== undefined) return cached;
  if (!isAgentAccountsConfigured()) {
    cached = null;
    return cached;
  }
  try {
    const keyring = loadAccountAuthorityKeyring(process.env);
    cached = createAccountAuthority({
      accounts: createAgentAccountRepository({ db }),
      facts: createAccountFactsRepository(),
      plane: createPlaneClient({ baseUrl: process.env[PLANE_URL_VAR]!.trim(), secret: process.env[PLANE_SERVICE_SECRET_VAR]!.trim() }),
      authorityKey: keyring.current,
      presenterKeyId: process.env[PRESENTER_KEY_ID_ENV]!.trim() as PresenterKeyId,
      registry: [],
      hash: (bytes) => createHash('sha3-256').update(bytes).digest('hex'),
      now: () => Date.now(),
    });
  } catch {
    cached = null;
  }
  return cached;
}
