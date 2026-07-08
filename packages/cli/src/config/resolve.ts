/**
 * resolveConfig — the pure config precedence resolver (Phase 4 task 1 /
 * Phase 4 intro "Auth precedence"): `--token`/`--host` flags > `PAGESPACE_TOKEN`/
 * `PAGESPACE_API_URL` env > loaded stored credential > defaults. Each field
 * (host, token) falls through the chain independently.
 *
 * `https://pagespace.ai` is the confirmed canonical API origin — already the
 * fixture host in every `@pagespace/sdk` transport test
 * (packages/sdk/src/transport/__tests__/build-request.test.ts).
 */

export const DEFAULT_HOST = 'https://pagespace.ai';

export interface ConfigFlags {
  readonly host?: string;
  readonly token?: string;
}

export interface ConfigEnv {
  readonly PAGESPACE_TOKEN?: string;
  readonly PAGESPACE_API_URL?: string;
}

/** The already-LOADED stored credential's contribution (host/token values), not a name — the caller loads it. */
export interface ConfigCredential {
  readonly host?: string;
  readonly token?: string;
}

export interface ConfigSources {
  readonly flags: ConfigFlags;
  readonly env: ConfigEnv;
  readonly credential: ConfigCredential | null;
}

export interface ResolvedConfig {
  readonly host: string;
  readonly token: string | undefined;
}

export function resolveConfig(sources: ConfigSources): ResolvedConfig {
  const host = sources.flags.host ?? sources.env.PAGESPACE_API_URL ?? sources.credential?.host ?? DEFAULT_HOST;
  const token = sources.flags.token ?? sources.env.PAGESPACE_TOKEN ?? sources.credential?.token ?? undefined;
  return { host, token };
}
