/**
 * Legacy credential env var support (Phase 6 task 1). The old standalone
 * `pagespace-mcp` server read its bearer token from `PAGESPACE_AUTH_TOKEN`
 * (`config.js`). The CLI's own `PAGESPACE_TOKEN` (Phase 4 task 7) always
 * takes precedence — this only fills `PAGESPACE_TOKEN`'s precedence slot
 * when it is itself absent (or blank), so existing `npx pagespace-mcp`
 * configs (and `pagespace mcp`, which shares this same resolver via
 * `run.ts` — no second, un-audited auth path) keep authenticating with zero
 * config change beyond eventually switching to `PAGESPACE_TOKEN` or
 * `pagespace login`. Pure: no I/O, never echoes the token value itself in
 * the deprecation notice.
 */
const LEGACY_TOKEN_ENV_VAR = 'PAGESPACE_AUTH_TOKEN';
const TOKEN_ENV_VAR = 'PAGESPACE_TOKEN';

export interface ResolvedEnvToken {
  readonly token: string | undefined;
  readonly deprecationNotice: string | null;
}

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function resolveEnvToken(env: Readonly<Record<string, string | undefined>>): ResolvedEnvToken {
  const token = present(env[TOKEN_ENV_VAR]);
  if (token !== undefined) {
    return { token, deprecationNotice: null };
  }

  const legacy = present(env[LEGACY_TOKEN_ENV_VAR]);
  if (legacy !== undefined) {
    return {
      token: legacy,
      deprecationNotice:
        `${LEGACY_TOKEN_ENV_VAR} is deprecated and will be removed in a future release. ` +
        `Set ${TOKEN_ENV_VAR} instead, or run "pagespace login".`,
    };
  }

  return { token: undefined, deprecationNotice: null };
}
