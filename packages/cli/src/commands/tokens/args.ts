/**
 * Pure argv → request mapping for `tokens create`/`tokens revoke` (Phase 4
 * task 6). Operates on the leftover raw tokens the router hands a matched
 * route (`CommandIntent.args` after the path prefix is stripped) — global
 * flags (`--json`, `--yes`, `--host`, `--token`) are already extracted by
 * `parseArgv` and never appear here.
 *
 * Role vocabulary mirrors the server's `/api/auth/mcp-tokens` route exactly
 * (`apps/web/src/app/api/auth/mcp-tokens/route.ts`): `member`/`admin` map to
 * the `MEMBER`/`ADMIN` enum (case-insensitive), any other value is treated as
 * a `customRoleId` reference. The server owns all capping/authorization
 * decisions (MEMBER-cannot-grant-ADMIN, custom-role ownership) — this module
 * only shapes the request, never validates authority.
 */

export interface DriveScopeArg {
  readonly id: string;
  readonly role: 'MEMBER' | 'ADMIN' | null;
  readonly customRoleId?: string;
}

export interface CreateTokenArgs {
  readonly name: string;
  readonly drives: readonly DriveScopeArg[];
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
  let name: string | undefined;
  const drives: DriveScopeArg[] = [];

  let i = 0;
  while (i < rest.length) {
    const token = rest[i];

    if (token === '--name') {
      const value = rest[i + 1];
      if (value === undefined) return { ok: false, message: 'Flag --name requires a value.' };
      name = value;
      i += 2;
      continue;
    }

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

    return { ok: false, message: `Unknown flag: ${token}` };
  }

  if (!name) return { ok: false, message: 'Flag --name is required.' };

  return { ok: true, args: { name, drives } };
}

export interface RevokeTokenArgs {
  readonly tokenId: string;
}

export type ParseTokensRevokeArgsResult =
  | { readonly ok: true; readonly args: RevokeTokenArgs }
  | { readonly ok: false; readonly message: string };

export function parseTokensRevokeArgs(rest: readonly string[]): ParseTokensRevokeArgsResult {
  const tokenId = rest[0];
  if (!tokenId) return { ok: false, message: 'Usage: pagespace tokens revoke <tokenId>' };
  if (rest.length > 1) return { ok: false, message: `Unexpected extra argument: ${rest[1]}` };
  return { ok: true, args: { tokenId } };
}
