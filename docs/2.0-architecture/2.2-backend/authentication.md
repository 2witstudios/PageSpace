# Authentication

Authentication is managed by a **custom JWT-based system** with multiple authentication providers, providing secure user session management with advanced security features.

## 1. Core Concepts

### 1.1. Authentication Strategy

*   **Multi-provider support:** The application supports email/password authentication and Google OAuth integration.
*   **Password Security:** User credentials are not stored in plaintext; passwords are hashed using `bcryptjs` with salt rounds of 10 before being saved to the database.
*   **User Roles:** The system supports role-based access control with `user` and `admin` roles.

### 1.2. Session Management

*   **JWT Tokens:** Sessions are managed using JSON Web Tokens (JWTs) with enhanced security features.
*   **Token Types:** Two types of tokens are used:
    *   **Access Token:** Short-lived (15 minutes) for API authentication
    *   **Refresh Token:** Long-lived (7 days) for obtaining new access tokens
*   **Token Security:** JWTs contain `userId`, `tokenVersion`, and `role` for comprehensive authorization.
*   **Token Rotation:** Refresh tokens are single-use and deleted after each refresh operation.
*   **Version Control:** `tokenVersion` field enables global session invalidation (e.g., on password change or security breach).

### 1.3. Security Features

*   **Rate Limiting:** Built-in rate limiting for login and refresh endpoints to prevent brute force attacks.
*   **Secure Cookies:** Tokens are stored in HTTP-only, secure, SameSite cookies.
*   **Session Tracking:** Refresh tokens include device, IP, and user agent information for audit trails.
*   **Token Theft Protection:** Automatic session invalidation when refresh token reuse is detected.
*   **Activity Logging:** Comprehensive logging and tracking of authentication events.

---

## 2. Database Schema

### 2.1. `users` Table

| Column | Type | Description |
| --- | --- | --- |
| `id` | `text` | Unique identifier for the user (CUID2). |
| `name` | `text` | The user's display name. |
| `email` | `text` | The user's email address (unique). |
| `emailVerified` | `timestamp` | When the user's email was verified. |
| `image` | `text` | A URL for the user's profile image. |
| `password` | `text` | The user's hashed password (nullable for OAuth users). |
| `googleId` | `text` | Google OAuth identifier (unique, nullable). |
| `provider` | `AuthProvider` | Authentication provider: `email`, `google`, or `both`. |
| `tokenVersion` | `integer` | Version number for token invalidation (default: 0). |
| `role` | `UserRole` | User role: `user` or `admin` (default: `user`). |
| `currentAiProvider` | `text` | Current AI provider preference (default: `pagespace`). |
| `currentAiModel` | `text` | Current AI model preference (default: `qwen/qwen3-coder:free`). |

### 2.2. `refresh_tokens` Table

| Column | Type | Description |
| --- | --- | --- |
| `id` | `text` | Unique identifier for the refresh token (CUID2). |
| `userId` | `text` | Foreign key to the user the token belongs to. |
| `token` | `text` | The refresh token value (unique). |
| `device` | `text` | Device information from User-Agent header. |
| `ip` | `text` | IP address where the token was issued. |
| `userAgent` | `text` | Full User-Agent string for device identification. |
| `createdAt` | `timestamp` | When the token was created. |

### 2.3. `mcp_tokens` Table

| Column | Type | Description |
| --- | --- | --- |
| `id` | `text` | Unique identifier for the MCP token (CUID2). |
| `userId` | `text` | Foreign key to the user the token belongs to. |
| `token` | `text` | The MCP token value (unique, prefixed with `mcp_`). |
| `name` | `text` | User-defined name for the token. |
| `lastUsed` | `timestamp` | When the token was last used (nullable). |
| `createdAt` | `timestamp` | When the token was created. |
| `revokedAt` | `timestamp` | When the token was revoked (nullable). |

---

## 3. API Routes

### 3.1. Core Authentication

**`POST /api/auth/signup`**
- **Purpose:** User registration with email and password
- **Location:** [`apps/web/src/app/api/auth/signup/route.ts:21`](apps/web/src/app/api/auth/signup/route.ts:21)
- **Body:** `{ name, email, password }`
- **Returns:** User info and sets authentication cookies
- **Side Effects:** Creates personal drive, sets up default AI settings, logs event

**`POST /api/auth/login`**
- **Purpose:** User authentication with email and password
- **Location:** [`apps/web/src/app/api/auth/login/route.ts:18`](apps/web/src/app/api/auth/login/route.ts:18)
- **Body:** `{ email, password }`
- **Returns:** User info and sets authentication cookies
- **Security:** Rate limiting by IP and email, activity logging

**`GET /api/auth/me`**
- **Purpose:** Get current authenticated user information
- **Location:** [`apps/web/src/app/api/auth/me/route.ts:4`](apps/web/src/app/api/auth/me/route.ts:4)
- **Auth Required:** Yes (access token)
- **Returns:** User profile without sensitive data

**`POST /api/auth/refresh`**
- **Purpose:** Refresh access token using refresh token
- **Location:** [`apps/web/src/app/api/auth/refresh/route.ts:8`](apps/web/src/app/api/auth/refresh/route.ts:8)
- **Security:** Single-use refresh tokens, rate limiting, token theft detection

**`POST /api/auth/logout`**
- **Purpose:** Log out user and invalidate tokens
- **Location:** [`apps/web/src/app/api/auth/logout/route.ts:8`](apps/web/src/app/api/auth/logout/route.ts:8)
- **Side Effects:** Deletes refresh token, clears cookies, logs event

### 3.2. OAuth Integration

**`GET /api/auth/google/signin`**
- **Purpose:** Initiate Google OAuth flow
- **Returns:** Google authorization URL

**`GET /api/auth/google/callback`**
- **Purpose:** Handle Google OAuth callback
- **Side Effects:** Creates user if needed, sets authentication cookies

### 3.3. MCP Token Management

**`POST /api/auth/mcp-tokens`**
- **Purpose:** Create new MCP (Model Context Protocol) token for API access
- **Location:** [`apps/web/src/app/api/auth/mcp-tokens/route.ts:21`](apps/web/src/app/api/auth/mcp-tokens/route.ts:21)
- **Body:** `{ name }`
- **Returns:** Token details (token value only shown once)

**`GET /api/auth/mcp-tokens`**
- **Purpose:** List user's MCP tokens (without token values)
- **Location:** [`apps/web/src/app/api/auth/mcp-tokens/route.ts:66`](apps/web/src/app/api/auth/mcp-tokens/route.ts:66)
- **Returns:** Array of token metadata

**`DELETE /api/auth/mcp-tokens/[tokenId]`**
- **Purpose:** Revoke specific MCP token
- **Auth Required:** Yes (user must own token)

### 3.4. Security Endpoints

**`GET /api/auth/csrf`**
- **Purpose:** CSRF protection endpoint
- **Returns:** CSRF token for form protection

---

## 4. Core Functions

The core authentication logic is located in `packages/lib/src/auth-utils.ts`.

### decodeToken(token: string): Promise<UserPayload | null>
**Purpose:** Verifies and decodes a JWT, returning the user payload if valid.
**Location:** [`packages/lib/src/auth-utils.ts:29`](packages/lib/src/auth-utils.ts:29)
**Dependencies:** `jose`
**Security:** Validates token signature, expiration, issuer, audience, and payload structure
**Last Updated:** 2025-08-21

### generateAccessToken(userId: string, tokenVersion: number, role: string): Promise<string>
**Purpose:** Creates a short-lived JWT (15 minutes) for API authentication.
**Location:** [`packages/lib/src/auth-utils.ts:56`](packages/lib/src/auth-utils.ts:56)
**Dependencies:** `jose`
**Includes:** userId, tokenVersion, role, standard JWT claims
**Last Updated:** 2025-08-21

### generateRefreshToken(userId: string, tokenVersion: number, role: string): Promise<string>
**Purpose:** Creates a long-lived JWT (7 days) for token refresh operations.
**Location:** [`packages/lib/src/auth-utils.ts:67`](packages/lib/src/auth-utils.ts:67)
**Dependencies:** `jose`
**Security:** Includes JTI (JWT ID) for single-use enforcement
**Last Updated:** 2025-08-21

### isAdmin(userPayload: UserPayload): boolean
**Purpose:** Check if user has admin role.
**Location:** [`packages/lib/src/auth-utils.ts:79`](packages/lib/src/auth-utils.ts:79)
**Returns:** True if user role is 'admin'
**Last Updated:** 2025-08-21

### requireAdminPayload(userPayload: UserPayload | null): void
**Purpose:** Throws error if user is not admin.
**Location:** [`packages/lib/src/auth-utils.ts:83`](packages/lib/src/auth-utils.ts:83)
**Use Case:** Protecting admin-only endpoints
**Last Updated:** 2025-08-21

---

## 5. Security Features

### 5.1. JWT Configuration

- **Algorithm:** HS256 (HMAC with SHA-256)
- **Secret:** Configurable via `JWT_SECRET` environment variable (minimum 32 characters)
- **Issuer/Audience:** Configurable for token validation
- **Claims Validation:** Strict validation of all required payload fields

### 5.2. Rate Limiting

- **Login Attempts:** Protected by IP and email-based rate limiting
- **Refresh Attempts:** Separate rate limiting for token refresh operations
- **Automatic Reset:** Rate limits reset on successful authentication

### 5.3. Token Security

- **Single-Use Refresh:** Refresh tokens are deleted after use to prevent replay attacks
- **Token Theft Detection:** Reuse of refresh tokens triggers session invalidation
- **Version Control:** Global session invalidation via tokenVersion increment
- **Secure Storage:** HTTP-only, secure, SameSite cookies

### 5.4. Activity Monitoring

- **Authentication Events:** Comprehensive logging of login, logout, signup events
- **Activity Tracking:** User activity tracking for security analysis
- **Session Metadata:** Device, IP, and user agent tracking for audit trails

---

## 6. Key Changes from Previous Implementation

### 6.1. Enhanced Security Features

- **Multi-provider authentication:** Added Google OAuth support alongside email/password
- **Role-based access control:** Added user/admin role system
- **MCP token system:** Added API tokens for programmatic access
- **Advanced rate limiting:** Implemented sophisticated rate limiting with retry logic
- **Token theft protection:** Enhanced security with single-use refresh tokens

### 6.2. Improved Database Schema

- **Provider tracking:** Added `provider` and `googleId` fields for OAuth support
- **Role system:** Added `role` enum for access control
- **AI preferences:** Added `currentAiProvider` and `currentAiModel` for user settings
- **MCP tokens:** New table for API access tokens with revocation support

### 6.3. Enhanced Monitoring

- **Activity tracking:** Comprehensive event tracking for security analysis
- **Structured logging:** Detailed logging with contextual information
- **Session auditing:** Full audit trail of authentication events

### 6.4. Production Readiness

- **Environment-based configuration:** Production vs development cookie settings
- **Domain configuration:** Configurable cookie domains for deployment
- **CSRF protection:** Built-in CSRF token generation
- **Error handling:** Comprehensive error handling with security in mind

This authentication system provides enterprise-grade security while maintaining ease of use and extensibility for future authentication providers.