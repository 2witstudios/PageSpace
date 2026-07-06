/**
 * resolveAuth — the auth precedence resolver (Phase 4 task 7; ADR 0003 §4,
 * §6 `resolveCredentialSource`). PURE: no I/O, no clock — every input is a
 * plain value already fetched by the caller (`run.ts`), so every branch of
 * the fixed contract (`--token` flag > `PAGESPACE_TOKEN` env > stored
 * profile for the resolved host+profile name > none) is exhaustively
 * table-testable.
 *
 * Presence means non-empty after trim; a present source never falls
 * through to a lower one, even if a lower source also has a value — and an
 * empty/whitespace-only value is treated as absent rather than "authenticated
 * as nobody" (ADR 0003 §4). `profiles` is keyed by host, then by profile
 * name (Phase 8 task 3) — a stored credential for a *different* host, or a
 * *different* profile name on the same host, is invisible here and simply
 * falls through to `none`, never leaking a credential minted for another
 * host/profile.
 */
import type { HostCredential } from '../credentials/serialize.js';
import { DEFAULT_PROFILE_NAME } from '../credentials/serialize.js';
import { resolveEnvToken } from './legacy-token-env.js';

export interface ResolveAuthFlags {
  readonly token?: string;
}

export interface ResolveAuthEnv {
  readonly PAGESPACE_TOKEN?: string;
}

export type AuthSource =
  | { readonly kind: 'flag'; readonly token: string }
  | { readonly kind: 'env'; readonly token: string }
  | { readonly kind: 'profile'; readonly host: string; readonly profileName?: string; readonly credential: HostCredential }
  | { readonly kind: 'none'; readonly host: string };

function presentToken(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export interface ResolveProfileNameFlags {
  readonly profile?: string;
}

export interface ResolveProfileNameEnv {
  readonly PAGESPACE_PROFILE?: string;
}

/** Same precedence shape as `resolveAuth`: `--profile` flag > `PAGESPACE_PROFILE` env > `"default"`. */
export function resolveProfileName(flags: ResolveProfileNameFlags, env: ResolveProfileNameEnv): string {
  const flagProfile = presentToken(flags.profile);
  if (flagProfile !== null) return flagProfile;

  const envProfile = presentToken(env.PAGESPACE_PROFILE);
  if (envProfile !== null) return envProfile;

  return DEFAULT_PROFILE_NAME;
}

export function resolveAuth(
  flags: ResolveAuthFlags,
  env: ResolveAuthEnv,
  profiles: Readonly<Record<string, Readonly<Record<string, HostCredential>>>>,
  host: string,
  profileName: string = DEFAULT_PROFILE_NAME,
): AuthSource {
  const flagToken = presentToken(flags.token);
  if (flagToken !== null) {
    return { kind: 'flag', token: flagToken };
  }

  const envToken = presentToken(env.PAGESPACE_TOKEN);
  if (envToken !== null) {
    return { kind: 'env', token: envToken };
  }

  if (Object.hasOwn(profiles, host)) {
    const hostProfiles = profiles[host];
    if (Object.hasOwn(hostProfiles, profileName)) {
      return { kind: 'profile', host, profileName, credential: hostProfiles[profileName] };
    }
  }

  return { kind: 'none', host };
}

/** Actionable, secret-free — the exact message shown when every precedence source is empty. */
export function missingCredentialsMessage(host: string): string {
  return (
    `No PageSpace credentials found for ${host}. Provide one of: ` +
    `--token <token>, the PAGESPACE_TOKEN environment variable, or run "pagespace login".`
  );
}

/**
 * The CLI-wide fail-closed gate (Phase 8 task 4, generalized to every
 * non-exempt command in Phase 9 task 4): does this invocation name a
 * credential itself? Deliberately NOT `resolveAuth`/`resolveProfileName` —
 * both of those intentionally fall through to the stored "default" profile
 * when nothing is given, which is exactly the ambient-personal-login fallback
 * this gate exists to block for every command that touches `ctx.sdk`. Lives
 * here rather than in a command module so no command file has to reference
 * `PAGESPACE_TOKEN`/`PAGESPACE_PROFILE` itself (see
 * `commands/__tests__/single-auth-path.test.ts`). Routes the token check
 * through `resolveEnvToken` (not a raw `env.PAGESPACE_TOKEN` read) so the
 * legacy `PAGESPACE_AUTH_TOKEN` env var — an explicit token under an old
 * name, not the ambient fallback this gate exists to block — still counts,
 * keeping `npx pagespace-mcp` configs working exactly as before.
 */
export function hasExplicitCredential(
  flags: ResolveAuthFlags & ResolveProfileNameFlags,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return (
    presentToken(flags.token) !== null ||
    resolveEnvToken(env).token !== undefined ||
    presentToken(flags.profile) !== null ||
    presentToken(env.PAGESPACE_PROFILE) !== null
  );
}

/** Companion message for `hasExplicitCredential` returning `false` — secret-free, points at the fix. */
export function noExplicitCredentialMessage(): string {
  return (
    'No explicit credential found — pagespace never falls back to your personal login for this ' +
    'command. Run "pagespace tokens create --drive <driveId> --role member --save-as-profile agent" ' +
    'and pass the result via the PAGESPACE_TOKEN environment variable or --profile agent.'
  );
}
