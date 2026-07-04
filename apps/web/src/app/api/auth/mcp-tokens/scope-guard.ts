import { NextResponse } from 'next/server';
import { isScopedOAuthAuth } from '@/lib/auth';

/**
 * A drive-scoped OAuth token acts as an app member for that drive only (ADR
 * 0002 Decision 2) — it must never mint, list, revoke, or manage the full
 * mcp_* credential surface. Only a full-user credential (session, or an
 * account-scoped OAuth token) may reach these routes. Shared by
 * `mcp-tokens/route.ts` and `mcp-tokens/[tokenId]/route.ts`.
 */
export function rejectScopedOAuth(auth: Parameters<typeof isScopedOAuthAuth>[0]): NextResponse | null {
  if (isScopedOAuthAuth(auth)) {
    return NextResponse.json({ error: 'insufficient_scope' }, { status: 403 });
  }
  return null;
}
