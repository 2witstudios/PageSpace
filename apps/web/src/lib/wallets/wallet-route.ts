/**
 * Shared pieces of the wallet routes (Spec UI-9, UI-10, SPEND-2, SPEND-3, X-1).
 *
 * Authentication: READS accept a session or an MCP token (the CLI and MCP mirror, X-1); a
 * drive route checks the token's drive scope, and an account-wide read (my wallets, a
 * conversation's source) refuses a drive-scoped token, since it would list drives outside
 * the scope. WRITES — every money move and every source change — are session + CSRF only
 * until MCP-token writes are ruled on.
 */
import { NextResponse } from 'next/server';
import { getAllowedDriveIds, isMCPAuthResult, type AuthResult } from '@/lib/auth';
import type { WalletServiceError } from '@pagespace/lib/services/drive-wallet-service';

export const WALLET_READ_AUTH = { allow: ['session', 'mcp'] as const, requireCSRF: false };
export const WALLET_WRITE_AUTH = { allow: ['session'] as const, requireCSRF: true };

/** The service's refusal as JSON: its own status, message, code (and delete blockers). */
export function walletErrorResponse(error: WalletServiceError): NextResponse {
  return NextResponse.json(
    { error: error.message, code: error.code, ...(error.blockers ? { blockers: error.blockers } : {}) },
    { status: error.status },
  );
}

/** A drive-scoped token may not read account-wide wallet data; null when allowed. */
export function refuseScopedTokenForAccountRead(auth: AuthResult): NextResponse | null {
  if (isMCPAuthResult(auth) && getAllowedDriveIds(auth).length > 0) {
    return NextResponse.json({ error: 'This token is limited to specific drives and cannot read account-wide wallets' }, { status: 403 });
  }
  return null;
}
