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

/**
 * Largest delay `setTimeout` honours (2^31-1 ms, ~24.8 days). Beyond it Node
 * warns and silently substitutes 1ms — so an absurdly long timeout would abort
 * IMMEDIATELY rather than waiting a long time, which is the opposite of what
 * the caller asked for and indistinguishable at the call site from a fast
 * server hang-up.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Whether a millisecond deadline is one a caller could actually have meant.
 *
 * Validated AFTER conversion, not before: `--timeout 0.0001` is a positive,
 * finite number of seconds that rounds to 0ms, and `--timeout 1e308` is finite
 * until multiplied by 1000. Both produce a client that aborts every request
 * instantly. That failure is especially bad here because an explicitly-supplied
 * `timeoutMs` outranks an operation's own default — so the caller who asked to
 * wait LONGER is the one whose requests stop working.
 */
export function isUsableTimeoutMs(value: number): boolean {
  return Number.isFinite(value) && value >= 1 && value <= MAX_TIMEOUT_MS;
}

/**
 * The request deadline, in milliseconds, or `undefined` to leave every
 * operation on its own declared default.
 *
 * `--timeout <seconds>` (already converted to ms by parseArgv) beats
 * `PAGESPACE_TIMEOUT_MS`, matching the flag > env precedence every other
 * setting here uses. The env var is milliseconds rather than seconds because
 * its audience is the MCP server's config file, not a human at a prompt —
 * `pagespace mcp` builds the same client every CLI verb uses, so this is the
 * one place an MCP host can raise the deadline for `ask_agent` consultations
 * it runs on an operator's behalf.
 *
 * An unusable env value is IGNORED rather than fatal: a bad `--timeout` is a
 * caller typo worth stopping for, but a stale env var in a shell profile
 * should not make every command in that shell unrunnable. Pure; reads nothing.
 */
export function resolveTimeoutSetting(
  flagTimeoutMs: number | undefined,
  env: { readonly PAGESPACE_TIMEOUT_MS?: string },
): number | undefined {
  if (flagTimeoutMs !== undefined) return flagTimeoutMs;
  const raw = env.PAGESPACE_TIMEOUT_MS;
  if (raw === undefined) return undefined;
  const parsedMs = Math.round(Number(raw.trim()));
  // Rounded first: a sub-millisecond value is positive and finite but rounds to
  // 0, which would abort every request instantly.
  if (!isUsableTimeoutMs(parsedMs)) return undefined;
  return parsedMs;
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
