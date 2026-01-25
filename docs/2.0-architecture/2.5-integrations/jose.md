# Integration: jose

> **⚠️ ARCHIVED (2026-01-24):** The `jose` library has been removed from PageSpace as part of the P5-T5 Legacy JWT Deprecation effort. All authentication now uses opaque session tokens stored in the database. See [authentication.md](../2.2-backend/authentication.md) for the current session-based architecture.

---

**HISTORICAL DOCUMENTATION** - This document describes the legacy JWT implementation that has been replaced.

This document outlines how pagespace previously used the `jose` library for all JSON Web Token (JWT) operations.

## Overview

`jose` is a powerful, zero-dependency library for creating and verifying JWTs. We use it to implement a standard Access Token / Refresh Token authentication pattern. All JWT-related logic is centralized in the shared `@pagespace/lib` package.

## Core Implementation: `@pagespace/lib`

The canonical implementation of our JWT logic resides in [`packages/lib/src/auth-utils.ts`](packages/lib/src/auth-utils.ts:1). These functions are used by our authentication API routes and any other part of the system that needs to handle tokens (like the `realtime` server).

### Token Generation

We generate two types of tokens:

1.  **Access Token:** A short-lived token (15 minutes) that grants access to protected API routes.
    -   `generateAccessToken(userId: string, tokenVersion: number, role: 'user' | 'admin')`
2.  **Refresh Token:** A long-lived token (7 days) that can be used to obtain a new access token without requiring the user to log in again.
    -   `generateRefreshToken(userId: string, tokenVersion: number, role: 'user' | 'admin')`

Both functions use `jose.SignJWT` to create a token, setting the algorithm to `HS256` and signing it with a shared secret. The refresh token also includes a unique JTI (JWT ID) for additional security.

### Token Verification

The `decodeToken(token: string)` function is used to verify and decode an incoming token. It uses `jose.jwtVerify` to:
1.  Check the token's signature against the `JWT_SECRET`.
2.  Verify that the token has not expired.
3.  Ensure the algorithm is `HS256`.
4.  Validate the issuer and audience claims.
5.  Verify all required payload fields are present and valid.

If the token is valid, it returns the payload; otherwise, it returns `null`.

### Token Payload

Our JWT payload is defined by the `UserPayload` interface and contains three crucial pieces of information:

-   `userId`: The ID of the user the token belongs to.
-   `tokenVersion`: An integer that is incremented in the `users` table whenever a user's credentials change (e.g., password reset). When verifying a token, we check that the `tokenVersion` in the payload matches the `tokenVersion` in the database. This is a critical security measure that allows us to instantly invalidate all of a user's existing tokens.
-   `role`: The user's role ('user' or 'admin'), used for authorization and access control.

## Web App Implementation

The web application has its own auth utilities in [`apps/web/src/lib/auth-utils.ts`](apps/web/src/lib/auth-utils.ts:1) that **properly imports and uses** the canonical `decodeToken` function from `@pagespace/lib`. This file provides:

-   `authenticateRequest(request: Request)`: A Next.js-specific helper that extracts JWT tokens from either Authorization headers or cookies and authenticates the request using the shared `decodeToken` function.

This approach correctly centralizes the core JWT logic while providing web-specific convenience functions.

## Security Configuration

-   **Algorithm:** We use the `HS256` (HMAC with SHA-256) algorithm for signing all our tokens.
-   **Secret Key:** The signing secret is stored in the `JWT_SECRET` environment variable. This is a critical secret and must be at least 32 characters long for security.
-   **Issuer/Audience:** Configurable via `JWT_ISSUER` and `JWT_AUDIENCE` environment variables (defaults to "pagespace" and "pagespace-users").
-   **Validation:** The system performs comprehensive validation including secret length checks, payload field validation, and claim verification.

## Additional Security Features

-   **Role-Based Access Control:** Helper functions `isAdmin(userPayload)` and `requireAdminPayload(userPayload)` for authorization.
-   **Unique Token IDs:** Refresh tokens include a JTI (JWT ID) using `createId()` from `@paralleldrive/cuid2` for enhanced security.
-   **Comprehensive Error Handling:** All JWT operations include proper error handling and validation.

**Last Updated:** 2025-08-21