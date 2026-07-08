/**
 * resolveAuth — the auth precedence resolver (Phase 4 task 7; ADR 0003 §4,
 * §6 `resolveCredentialSource`). PURE: no I/O, no clock — every input is a
 * plain value already fetched by the caller (`run.ts`), so every branch of
 * the fixed contract (`--token` flag > `PAGESPACE_TOKEN` env > stored
 * key for the resolved host+key name > none) is exhaustively
 * table-testable.
 *
 * Presence means non-empty after trim; a present source never falls
 * through to a lower one, even if a lower source also has a value — and an
 * empty/whitespace-only value is treated as absent rather than "authenticated
 * as nobody" (ADR 0003 §4). `stored` is keyed by host, then by key
 * name (Phase 8 task 3) — a stored credential for a *different* host, or a
 * *different* key name on the same host, is invisible here and simply
 * falls through to `none`, never leaking a credential minted for another
 * host/key.
 */
import type { HostCredential } from '../credentials/serialize.js';
import { DEFAULT_PROFILE_NAME } from '../credentials/serialize.js';
import { resolveEnvKeyName, resolveEnvToken } from './legacy-token-env.js';

export interface ResolveAuthFlags {
  readonly token?: string;
}

export interface ResolveAuthEnv {
  readonly PAGESPACE_TOKEN?: string;
}

/**
 * The token env var's NAME, for display copy (post-mint agent-wiring
 * guidance, `--show-token` output). Command modules must interpolate this
 * constant instead of writing the literal — the `single-auth-path.test.ts`
 * tripwire greps command sources for the raw string precisely so that no
 * command grows its own env read, and display copy must not blunt that
 * tripwire by making the literal commonplace there.
 */
export const TOKEN_ENV_VAR_NAME = 'PAGESPACE_TOKEN';

/** The key-name env var's NAME, for display copy — same tripwire-preserving reasoning as `TOKEN_ENV_VAR_NAME`. */
export const KEY_ENV_VAR_NAME = 'PAGESPACE_KEY';

export type AuthSource =
  | { readonly kind: 'flag'; readonly token: string }
  | { readonly kind: 'env'; readonly token: string }
  | { readonly kind: 'stored'; readonly host: string; readonly keyName?: string; readonly credential: HostCredential }
  | { readonly kind: 'none'; readonly host: string };

function presentToken(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export interface ResolveKeyNameFlags {
  readonly key?: string;
}

export interface ResolveKeyNameEnv {
  readonly PAGESPACE_KEY?: string;
}

/**
 * Same precedence shape as `resolveAuth`: `--key` flag > `PAGESPACE_KEY` env
 * > `"default"` (the slot `pagespace login` stores your login credential
 * under). Callers that resolve from a real environment must pass
 * `resolveEnvKeyName(env).name` as `PAGESPACE_KEY` so the deprecated
 * `PAGESPACE_PROFILE` alias keeps filling the same slot — the alias folding
 * lives in ONE place (`legacy-token-env.ts`), never re-derived here.
 */
export function resolveKeyName(flags: ResolveKeyNameFlags, env: ResolveKeyNameEnv): string {
  const flagKey = presentToken(flags.key);
  if (flagKey !== null) return flagKey;

  const envKey = presentToken(env.PAGESPACE_KEY);
  if (envKey !== null) return envKey;

  return DEFAULT_PROFILE_NAME;
}

export function resolveAuth(
  flags: ResolveAuthFlags,
  env: ResolveAuthEnv,
  stored: Readonly<Record<string, Readonly<Record<string, HostCredential>>>>,
  host: string,
  keyName: string = DEFAULT_PROFILE_NAME,
): AuthSource {
  const flagToken = presentToken(flags.token);
  if (flagToken !== null) {
    return { kind: 'flag', token: flagToken };
  }

  const envToken = presentToken(env.PAGESPACE_TOKEN);
  if (envToken !== null) {
    return { kind: 'env', token: envToken };
  }

  if (Object.hasOwn(stored, host)) {
    const hostKeys = stored[host];
    if (Object.hasOwn(hostKeys, keyName)) {
      return { kind: 'stored', host, keyName, credential: hostKeys[keyName] };
    }
  }

  return { kind: 'none', host };
}

/** Actionable, secret-free — the exact message shown when every precedence source is empty. */
export function missingCredentialsMessage(host: string): string {
  return (
    `No PageSpace credentials found for ${host}. Provide one of: ` +
    `--token <token>, the PAGESPACE_TOKEN environment variable, --key <name> naming a stored key, or run "pagespace login".`
  );
}

/**
 * The CLI-wide fail-closed gate (Phase 8 task 4, generalized to every
 * non-exempt command in Phase 9 task 4): does this invocation name a
 * credential itself? Deliberately NOT `resolveAuth`/`resolveKeyName` —
 * both of those intentionally fall through to the stored "default" login
 * credential when nothing is given, which is exactly the
 * ambient-personal-login fallback this gate exists to block for every
 * command that touches `ctx.sdk`. Lives here rather than in a command module
 * so no command file has to reference `PAGESPACE_TOKEN`/`PAGESPACE_KEY`
 * itself (see `commands/__tests__/single-auth-path.test.ts`). Routes both
 * env checks through the `legacy-token-env.ts` resolvers (never raw env
 * reads) so the legacy names — `PAGESPACE_AUTH_TOKEN` for the token,
 * `PAGESPACE_PROFILE` for the key name; each an explicit credential under an
 * old name, not the ambient fallback this gate exists to block — still
 * count, keeping pre-rename `npx pagespace-mcp` configs working exactly as
 * before.
 *
 * Deliberately unaware of the active key (`pagespace keys use`): the active
 * key is a separate, host-scoped fallback `run.ts` layers on top for content
 * commands only — folding it in here would silently extend it to `pagespace
 * mcp`, which must keep refusing it.
 */
export function hasExplicitCredential(
  flags: ResolveAuthFlags & ResolveKeyNameFlags,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return (
    presentToken(flags.token) !== null ||
    resolveEnvToken(env).token !== undefined ||
    presentToken(flags.key) !== null ||
    resolveEnvKeyName(env).name !== undefined
  );
}

/** Companion message for `hasExplicitCredential` returning `false` — secret-free, points at the fix. */
export function noExplicitCredentialMessage(): string {
  return (
    'No explicit credential found — pagespace never falls back to your personal login for this ' +
    'command. Run "pagespace keys create --drive <driveId> --role member --name <name>" (or "pagespace keys" ' +
    'for the guided wizard) to mint a scoped key. ' +
    'Pass --key <name> (or set PAGESPACE_KEY), pass --token, or activate a key for this machine ' +
    'with "pagespace keys use <name>".'
  );
}

/**
 * The `pagespace mcp` variant of `noExplicitCredentialMessage` — mcp is
 * invoked unattended by an MCP client, so the active key (a human's
 * per-machine convenience for content commands) deliberately does not apply
 * to it and the message must not suggest it.
 */
export function mcpNoExplicitCredentialMessage(): string {
  return (
    'No explicit credential found — pagespace never falls back to your personal login for this ' +
    'command. Run "pagespace keys create --drive <driveId> --role member --name <name>" (or "pagespace keys" ' +
    'for the guided wizard) to mint a scoped key, then name it explicitly in the MCP config: pass ' +
    '--key <name> (or set PAGESPACE_KEY), or pass --token. The active key set by "pagespace keys use" ' +
    'deliberately does not apply to "pagespace mcp".'
  );
}
