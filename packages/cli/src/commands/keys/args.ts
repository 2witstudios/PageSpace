/**
 * Pure argv → request mapping for `keys create`/`keys revoke`/`keys use`
 * (Phase 8 task 2). Operates on the leftover raw tokens the router hands a
 * matched route (`CommandIntent.args` after the path prefix is stripped) —
 * global flags (`--json`, `--yes`, `--host`, `--token`, `--key`) are already
 * extracted by `parseArgv` and never appear here.
 *
 * Role vocabulary mirrors the OAuth drive-scope grammar
 * (`packages/lib/src/auth/oauth/scopes.ts`): `member`/`admin` map to the
 * `MEMBER`/`ADMIN` enum (case-insensitive), any other value is treated as a
 * `customRoleId` reference. This module only shapes the flags into data —
 * `create.ts`'s `buildTokenScope` owns validating that data against the wire
 * grammar before a scope string ever reaches the server.
 */

export interface DriveScopeArg {
  readonly id: string;
  readonly role: 'MEMBER' | 'ADMIN' | null;
  readonly customRoleId?: string;
}

export interface CreateTokenArgs {
  readonly drives: readonly DriveScopeArg[];
  /** The key's local name (`--name`; pre-1.5.0: `--save-as-profile`). */
  readonly name?: string;
  /** Print the raw minted `mcp_*` token once (for .env/CI use) after a successful mint. */
  readonly showToken: boolean;
}

export type ParseTokensCreateArgsResult =
  | { readonly ok: true; readonly args: CreateTokenArgs }
  | { readonly ok: false; readonly message: string };

export const SAVE_AS_PROFILE_FLAG_RENAMED_MESSAGE = '--save-as-profile was renamed to --name in 1.5.0.';

function normalizeRole(value: string): Pick<DriveScopeArg, 'role' | 'customRoleId'> {
  const lower = value.toLowerCase();
  if (lower === 'member') return { role: 'MEMBER' };
  if (lower === 'admin') return { role: 'ADMIN' };
  return { role: null, customRoleId: value };
}

export function parseTokensCreateArgs(rest: readonly string[]): ParseTokensCreateArgsResult {
  let name: string | undefined;
  let showToken = false;
  const drives: DriveScopeArg[] = [];

  let i = 0;
  while (i < rest.length) {
    const token = rest[i];

    if (token === '--drive') {
      const value = rest[i + 1];
      if (value === undefined) return { ok: false, message: 'Flag --drive requires a value.' };
      drives.push({ id: value, role: null });
      i += 2;
      continue;
    }

    if (token === '--role') {
      const value = rest[i + 1];
      if (value === undefined) return { ok: false, message: 'Flag --role requires a value.' };
      const last = drives[drives.length - 1];
      if (!last) return { ok: false, message: '--role must follow a --drive flag.' };
      if (last.role !== null || last.customRoleId !== undefined) {
        return { ok: false, message: `--drive ${last.id} already has a --role.` };
      }
      drives[drives.length - 1] = { ...last, ...normalizeRole(value) };
      i += 2;
      continue;
    }

    if (token === '--save-as-profile' || token.startsWith('--save-as-profile=')) {
      return { ok: false, message: SAVE_AS_PROFILE_FLAG_RENAMED_MESSAGE };
    }

    if (token === '--name') {
      const value = rest[i + 1];
      if (value === undefined) return { ok: false, message: 'Flag --name requires a value.' };
      if (name !== undefined) {
        return { ok: false, message: 'Flag --name was given more than once.' };
      }
      name = value;
      i += 2;
      continue;
    }

    if (token === '--show-token') {
      if (showToken) {
        return { ok: false, message: 'Flag --show-token was given more than once.' };
      }
      showToken = true;
      i += 1;
      continue;
    }

    return { ok: false, message: `Unknown flag: ${token}` };
  }

  return { ok: true, args: { drives, name, showToken } };
}

export interface RevokeTokenArgs {
  readonly tokenId: string;
}

export type ParseTokensRevokeArgsResult =
  | { readonly ok: true; readonly args: RevokeTokenArgs }
  | { readonly ok: false; readonly message: string };

export function parseTokensRevokeArgs(rest: readonly string[]): ParseTokensRevokeArgsResult {
  const tokenId = rest[0];
  if (!tokenId) return { ok: false, message: 'Usage: pagespace keys revoke <tokenId>' };
  if (rest.length > 1) return { ok: false, message: `Unexpected extra argument: ${rest[1]}` };
  return { ok: true, args: { tokenId } };
}

export const KEYS_USE_USAGE_MESSAGE = 'Usage: pagespace keys use <name>   or:   pagespace keys use --off';

export type KeysUseArgs = { readonly kind: 'activate'; readonly name: string } | { readonly kind: 'off' };

export type ParseKeysUseArgsResult =
  | { readonly ok: true; readonly args: KeysUseArgs }
  | { readonly ok: false; readonly message: string };

/** `keys use <name>` activates a stored key for this machine; `keys use --off` deactivates. Exactly one of the two. */
export function parseKeysUseArgs(rest: readonly string[]): ParseKeysUseArgsResult {
  if (rest.length !== 1) {
    return { ok: false, message: KEYS_USE_USAGE_MESSAGE };
  }
  const token = rest[0];
  if (token === '--off') {
    return { ok: true, args: { kind: 'off' } };
  }
  if (token.startsWith('-')) {
    return { ok: false, message: KEYS_USE_USAGE_MESSAGE };
  }
  return { ok: true, args: { kind: 'activate', name: token } };
}
