/**
 * Auth engine types — pure, dependency-free leaf module.
 *
 * Contains only type/interface declarations for the token-authentication
 * engine. Importing from here drags in NO runtime code (all external imports
 * are `import type`), so client components and edge code can reference these
 * shapes without pulling `@pagespace/db` or any service into their graph.
 *
 * Runtime logic lives in `./auth-core` (pure functions) and `./request-auth`
 * (I/O shell).
 */
import type { NextResponse } from 'next/server';
import type { ScopeSet, DriveScopeRow } from '@pagespace/lib/auth/oauth/scopes';
import type { EnforcedAuthContext } from '@pagespace/lib/permissions/enforced-context';

export type TokenType = 'mcp' | 'session' | 'oauth';

export interface BaseAuthDetails {
  userId: string;
  role: 'user' | 'admin';
  tokenVersion: number;
  adminRoleVersion: number;
}

export interface MCPAuthDetails extends BaseAuthDetails {
  tokenId: string;
  // Drive IDs this token is scoped to. Empty array means access to ALL drives.
  allowedDriveIds: string[];
}

export interface MCPAuthResult extends MCPAuthDetails {
  tokenType: 'mcp';
}

export interface SessionAuthResult extends BaseAuthDetails {
  tokenType: 'session';
  sessionId: string;
}

export interface OAuthAuthDetails extends BaseAuthDetails {
  tokenId: string;
  scopes: ScopeSet;
  // Bridge to the mcp_token_drives-shaped capability model (ADR 0002 Decision 2).
  driveScopes: DriveScopeRow[];
  // Drive IDs this token is scoped to. Empty array means access to ALL drives
  // (the `account` scope) — same convention as MCPAuthDetails.allowedDriveIds.
  allowedDriveIds: string[];
}

export interface OAuthAuthResult extends OAuthAuthDetails {
  tokenType: 'oauth';
}

export type AuthResult = MCPAuthResult | SessionAuthResult | OAuthAuthResult;

export interface AuthError {
  error: NextResponse;
}

export type AuthenticationResult = AuthResult | AuthError;

export type AllowedTokenType = TokenType;

export interface AuthenticateOptions {
  allow: ReadonlyArray<AllowedTokenType>;
  requireCSRF?: boolean;
  requireOriginValidation?: boolean;
}

export interface EnforcedAuthSuccess {
  ctx: EnforcedAuthContext;
}

export interface EnforcedAuthError {
  error: NextResponse;
}

export type EnforcedAuthResult = EnforcedAuthSuccess | EnforcedAuthError;
