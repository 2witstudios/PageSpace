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

  const credential = profiles[host]?.[profileName];
  if (credential) {
    return { kind: 'profile', host, profileName, credential };
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
