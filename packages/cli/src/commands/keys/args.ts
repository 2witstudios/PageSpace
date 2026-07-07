/**
 * Pure argv → request mapping for `keys create`/`keys revoke` (Phase 8
 * task 2). Operates on the leftover raw tokens the router hands a matched
 * route (`CommandIntent.args` after the path prefix is stripped) — global
 * flags (`--json`, `--yes`, `--host`, `--token`, `--profile`) are already
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
  readonly saveAsProfile?: string;
}

export type ParseTokensCreateArgsResult =
  | { readonly ok: true; readonly args: CreateTokenArgs }
  | { readonly ok: false; readonly message: string };

function normalizeRole(value: string): Pick<DriveScopeArg, 'role' | 'customRoleId'> {
  const lower = value.toLowerCase();
  if (lower === 'member') return { role: 'MEMBER' };
  if (lower === 'admin') return { role: 'ADMIN' };
  return { role: null, customRoleId: value };
}

export function parseTokensCreateArgs(rest: readonly string[]): ParseTokensCreateArgsResult {
  let saveAsProfile: string | undefined;
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

    if (token === '--save-as-profile') {
      const value = rest[i + 1];
      if (value === undefined) return { ok: false, message: 'Flag --save-as-profile requires a value.' };
      if (saveAsProfile !== undefined) {
        return { ok: false, message: 'Flag --save-as-profile was given more than once.' };
      }
      saveAsProfile = value;
      i += 2;
      continue;
    }

    return { ok: false, message: `Unknown flag: ${token}` };
  }

  return { ok: true, args: { drives, saveAsProfile } };
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
