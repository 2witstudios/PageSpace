/**
 * `infisical-client` — the minimal HTTP client for self-hosted Infisical OSS
 * (D-21 revised): Universal Auth login + the v3 raw-secrets API. I/O only;
 * `store-adapter-infisical.ts` is the only caller and holds every decision.
 *
 * No SDK: `@infisical/sdk` pulls in a full gRPC/native-binding surface for a
 * handful of REST calls this client makes directly (task brief item 1).
 * `fetchImpl` is injected so this is testable without a network call and so
 * the integration test can point at the local docker-compose instance
 * (`store/infisical-dev/`) or a real deployment identically.
 *
 * One secret per `(accountId, kind)`, keyed `<accountId>__<kind>` at
 * `secretPath: '/'` in a fixed `environment` (the project — one per tenant,
 * D-17 — is the isolation boundary; the environment slot is not used for
 * anything else here). `PlaneBindings` ride in `secretComment` as JSON
 * (Infisical has no other free-form metadata field on the v3 raw API this
 * client uses); the adapter is the only reader.
 */

export type InfisicalConfig = {
  readonly baseUrl: string;
  readonly environment: string;
};

export type InfisicalCredentials = {
  readonly clientId: string;
  readonly clientSecret: string;
};

export type FetchImpl = typeof fetch;

export type InfisicalSecretRecord = {
  readonly secretValue: string;
  readonly secretComment: string;
  readonly version: number;
};

export type InfisicalGetResult =
  | { readonly ok: true; readonly secret: InfisicalSecretRecord }
  | { readonly ok: false; readonly reason: 'not_found' | 'unavailable' };

export type InfisicalWriteResult =
  | { readonly ok: true; readonly version: number }
  | { readonly ok: false; readonly reason: 'not_found' | 'unavailable' };

export type InfisicalDeleteResult = { readonly ok: true } | { readonly ok: false; readonly reason: 'not_found' | 'unavailable' };

export type InfisicalClient = {
  readonly getSecret: (input: { readonly projectId: string; readonly credentials: InfisicalCredentials; readonly secretKey: string }) => Promise<InfisicalGetResult>;
  readonly createSecret: (input: {
    readonly projectId: string;
    readonly credentials: InfisicalCredentials;
    readonly secretKey: string;
    readonly secretValue: string;
    readonly secretComment: string;
  }) => Promise<InfisicalWriteResult>;
  readonly updateSecret: (input: {
    readonly projectId: string;
    readonly credentials: InfisicalCredentials;
    readonly secretKey: string;
    readonly secretValue: string;
    readonly secretComment: string;
  }) => Promise<InfisicalWriteResult>;
  readonly deleteSecret: (input: { readonly projectId: string; readonly credentials: InfisicalCredentials; readonly secretKey: string }) => Promise<InfisicalDeleteResult>;
};

async function login(config: InfisicalConfig, credentials: InfisicalCredentials, fetchImpl: FetchImpl): Promise<{ ok: true; accessToken: string } | { ok: false }> {
  try {
    const response = await fetchImpl(`${config.baseUrl}/api/v1/auth/universal-auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: credentials.clientId, clientSecret: credentials.clientSecret }),
    });
    if (!response.ok) return { ok: false };
    const body = (await response.json()) as { accessToken?: string };
    return typeof body.accessToken === 'string' ? { ok: true, accessToken: body.accessToken } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function secretUrl(config: InfisicalConfig, secretKey: string): string {
  return `${config.baseUrl}/api/v3/secrets/raw/${encodeURIComponent(secretKey)}`;
}

export function createInfisicalClient(config: InfisicalConfig, fetchImpl: FetchImpl = fetch): InfisicalClient {
  async function authorize(credentials: InfisicalCredentials): Promise<{ ok: true; accessToken: string } | { ok: false }> {
    return login(config, credentials, fetchImpl);
  }

  return {
    async getSecret({ projectId, credentials, secretKey }) {
      const auth = await authorize(credentials);
      if (!auth.ok) return { ok: false, reason: 'unavailable' };
      try {
        const url = new URL(secretUrl(config, secretKey));
        url.searchParams.set('workspaceId', projectId);
        url.searchParams.set('environment', config.environment);
        url.searchParams.set('secretPath', '/');
        const response = await fetchImpl(url.toString(), { headers: { authorization: `Bearer ${auth.accessToken}` } });
        if (response.status === 404) return { ok: false, reason: 'not_found' };
        if (!response.ok) return { ok: false, reason: 'unavailable' };
        const body = (await response.json()) as { secret: { secretValue: string; secretComment: string | null; version: number } };
        return { ok: true, secret: { secretValue: body.secret.secretValue, secretComment: body.secret.secretComment ?? '', version: body.secret.version } };
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
    },

    async createSecret({ projectId, credentials, secretKey, secretValue, secretComment }) {
      const auth = await authorize(credentials);
      if (!auth.ok) return { ok: false, reason: 'unavailable' };
      try {
        const response = await fetchImpl(secretUrl(config, secretKey), {
          method: 'POST',
          headers: { authorization: `Bearer ${auth.accessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId: projectId, environment: config.environment, secretPath: '/', secretValue, secretComment }),
        });
        if (!response.ok) return { ok: false, reason: 'unavailable' };
        const body = (await response.json()) as { secret: { version: number } };
        return { ok: true, version: body.secret.version };
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
    },

    async updateSecret({ projectId, credentials, secretKey, secretValue, secretComment }) {
      const auth = await authorize(credentials);
      if (!auth.ok) return { ok: false, reason: 'unavailable' };
      try {
        const response = await fetchImpl(secretUrl(config, secretKey), {
          method: 'PATCH',
          headers: { authorization: `Bearer ${auth.accessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId: projectId, environment: config.environment, secretPath: '/', secretValue, secretComment }),
        });
        if (response.status === 404) return { ok: false, reason: 'not_found' };
        if (!response.ok) return { ok: false, reason: 'unavailable' };
        const body = (await response.json()) as { secret: { version: number } };
        return { ok: true, version: body.secret.version };
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
    },

    async deleteSecret({ projectId, credentials, secretKey }) {
      const auth = await authorize(credentials);
      if (!auth.ok) return { ok: false, reason: 'unavailable' };
      try {
        const response = await fetchImpl(secretUrl(config, secretKey), {
          method: 'DELETE',
          headers: { authorization: `Bearer ${auth.accessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId: projectId, environment: config.environment, secretPath: '/' }),
        });
        if (response.status === 404) return { ok: false, reason: 'not_found' };
        if (!response.ok) return { ok: false, reason: 'unavailable' };
        return { ok: true };
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
    },
  };
}
