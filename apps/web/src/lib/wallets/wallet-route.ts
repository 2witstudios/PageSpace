/**
 * Shared pieces of the wallet routes (Spec UI-9, UI-10, SPEND-2, SPEND-3, X-1).
 *
 * Authentication: READS accept a session or an MCP token (the CLI and MCP mirror, X-1); a
 * drive route checks the token's drive scope, and an account-wide read (my wallets, a
 * conversation's source) refuses a drive-scoped token, since it would list drives outside
 * the scope. WRITES admit an MCP token only so the service can refuse it BY NAME ([D-OW-26]:
 * a delegated token never moves money or changes a spend source); the service refuses before
 * it reads or writes anything. A session write still needs CSRF.
 */
import { NextResponse } from 'next/server';
import { getAllowedDriveIds, isMCPAuthResult, type AuthResult } from '@/lib/auth';
import type { WalletServiceError } from '@pagespace/lib/services/drive-wallet-service';
import type { WalletCredential } from '@pagespace/lib/permissions/wallet-access';

export const WALLET_READ_AUTH = { allow: ['session', 'mcp'] as const, requireCSRF: false };
export const WALLET_WRITE_AUTH = { allow: ['session', 'mcp'] as const, requireCSRF: true };

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

/**
 * How the caller authenticated, for the service's [D-OW-26] decisions. Only a real session is
 * `session`; every delegated credential (an MCP key, an OAuth connector token, a service hop)
 * is `mcp`, so it reads the consumer view and every write refuses it. The switch is exhaustive:
 * a new kind of AuthResult fails to compile here instead of silently getting session authority
 * if a route's `allow` list is ever widened.
 */
export function walletCredentialOf(auth: AuthResult): WalletCredential {
  switch (auth.tokenType) {
    case 'session':
      return 'session';
    case 'mcp':
    case 'oauth':
    case 'service':
      return 'mcp';
    default: {
      const unhandled: never = auth;
      return unhandled;
    }
  }
}
