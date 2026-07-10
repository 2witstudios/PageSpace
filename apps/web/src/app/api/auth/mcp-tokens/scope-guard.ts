import { NextResponse } from 'next/server';
import { isScopedOAuthAuth } from '@/lib/auth/principal-permissions';
import { isManageKeysOnly } from '@/lib/auth/auth-core';

/**
 * `isScopedOAuthAuth` covers two distinct credential shapes, which this guard
 * must tell apart:
 *
 * - A drive-scoped OAuth token acts as an app member for that drive only
 *   (ADR 0002 Decision 2) — it must never mint, list, revoke, or manage the
 *   full mcp_* credential surface, so it is rejected here.
 * - A manage_keys-only OAuth token carries no drive content access at all
 *   (see `isManageKeysOnly`), but minting/listing/revoking mcp_* credentials
 *   is exactly what that scope exists to grant, so it is let through.
 *
 * Only a full-user credential (session, account-scoped OAuth, or a
 * manage_keys-only OAuth token) may reach these routes. Shared by
 * `mcp-tokens/route.ts` and `mcp-tokens/[tokenId]/route.ts`.
 */
export function rejectScopedOAuth(auth: Parameters<typeof isScopedOAuthAuth>[0]): NextResponse | null {
  if (isScopedOAuthAuth(auth) && !isManageKeysOnly(auth)) {
    return NextResponse.json({ error: 'insufficient_scope' }, { status: 403 });
  }
  return null;
}
