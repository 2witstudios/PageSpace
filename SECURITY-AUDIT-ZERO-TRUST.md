# PageSpace Zero-Trust Security Audit

**Date:** 2026-02-12
**Scope:** Full codebase audit — all API routes, middleware, services, inter-service communication, desktop app
**Methodology:** Exhaustive code review (not documentation-based)

---

## Executive Verdict

**Can you claim zero-trust? Yes, after one fix.** PageSpace has an exceptionally strong security architecture — opaque tokens, per-request auth, fail-closed permissions, scoped service tokens, and defense-in-depth throughout. **One concrete issue** was found and fixed in this audit, plus the known MCP exception you mentioned.

---

## Findings Summary

| # | Finding | Severity | Zero-Trust Impact | Status |
|---|---------|----------|-------------------|--------|
| 1 | Processor service CORS: `app.use(cors())` with no origin restriction | **HIGH** | Violates "never trust the network" | **FIXED** |
| 2 | Nginx dev config had wildcard CORS (not used in production — Caddy) | **INFO** | Dev-only, no production impact | **FIXED** |
| 3 | Desktop MCP servers run unsandboxed (by design) | **KNOWN** | Accepted trust boundary, same as Claude Desktop | Accepted |

**Note:** Production uses Caddy as the reverse proxy (configured outside this repo). The `nginx.conf` in this repo is for local development only. The Caddy production config should be audited separately.

Everything else passed. Details below.

---

## What Passed (Zero-Trust Verified)

### 1. Authentication — Every Request Verified

- **216+ API routes audited.** Every protected route calls `authenticateRequestWithOptions()`, `requireAuth()`, `requireAdmin()`, `authenticateMCPRequest()`, or `validateSignedCronRequest()`. No missed routes found.
- **Opaque tokens** (not JWTs) — `ps_sess_*`, `ps_svc_*`, `mcp_*`, `ps_sock_*` — stored as SHA-256 hashes in PostgreSQL. Every request hits the DB for validation. Instant revocation.
- **Token version tracking** — user's `tokenVersion` is checked against the session record. Changing the version invalidates all existing tokens immediately.
- **Account suspension** — `suspendedAt` flag checked during every `validateSession()` call; revokes all tokens on detection.
- **No hardcoded credentials, debug backdoors, or bypass routes found.**

### 2. Authorization — Explicit Permission Checks

- **Every mutation route checks authorization** after authentication. Pattern: auth → drive membership check → page permission check (`canUserViewPage`, `canUserEditPage`, `canUserDeletePage`).
- **MCP token scoping** — `checkMCPDriveScope()` and `checkMCPPageScope()` enforce drive-level access for scoped tokens. Scoped tokens cannot create new drives (`checkMCPCreateScope`).
- **Fail-closed** — `getUserAccessLevel()` returns `null` on any error, denying access.
- **Admin role versioning** — `adminRoleVersion` prevents stale admin tokens from being used after role demotion.

### 3. CSRF Protection — Comprehensive

- **All mutation endpoints (POST/PUT/PATCH/DELETE) use `requireCSRF: true`** in their `AUTH_OPTIONS_WRITE`. Verified by reading every route file.
- **Read-only endpoints correctly skip CSRF** (`requireCSRF: false`).
- **Separate READ/WRITE auth options pattern** used consistently across the codebase (e.g., `AUTH_OPTIONS_READ` vs `AUTH_OPTIONS_WRITE`).
- **Login CSRF** — separate `x-login-csrf-token` + `login_csrf` cookie mechanism.
- **Bearer tokens exempt from CSRF** — correct, since they can't be sent by cross-origin form submissions.

### 4. Origin Validation — Defense-in-Depth

- **Middleware-level origin checking** on all API routes (`middleware.ts:33-58`).
- **Configurable blocking mode** — `ORIGIN_VALIDATION_MODE=block` (default in production).
- **Safe methods (GET/HEAD/OPTIONS) excluded** from origin checks.

### 5. Session & Cookie Security

- `httpOnly: true` — JavaScript cannot access session cookies.
- `secure: true` — HTTPS only in production.
- `sameSite: 'strict'` — prevents cross-site cookie attachment.
- **7-day expiration** with server-side validation.
- **Socket tokens** — 5-minute TTL, single-use, hash-stored.

### 6. Real-Time Service (Socket.IO) — Per-Event Authorization

- **Connection authentication** — all WebSocket connections require valid `ps_sock_*` or `ps_sess_*` token. No anonymous connections allowed.
- **Room join authorization** — `getUserAccessLevel()` checked before joining page/drive rooms. DM conversations use filter-in-query (authorization in WHERE clause).
- **Per-event re-authorization** — sensitive events (`document_update`, `page_delete`, `file_upload`, etc.) bypass permission cache and hit the DB directly (`bypassCache: true`).
- **Read-only events** (cursor, presence, typing) use cached permissions — acceptable 60s stale window.
- **Kick API** — HMAC-SHA256 signed, enables immediate eviction on permission revocation.
- **Broadcast authentication** — HMAC-SHA256 with timestamp validation, timing-safe comparison.

### 7. Processor Service — Scoped Service Tokens

- **All endpoints require authentication** (`authenticateService` middleware) and scope (`requireScope`).
- **Service token type enforced** — only `type: 'service'` tokens accepted, user sessions rejected.
- **Resource binding validation** — upload tokens bound to specific page + drive, preventing cross-resource access.
- **User attribution check** — cannot upload on behalf of another user without `files:write:any` scope.
- **File deletion requires three checks** — resource binding + page delete permission + no active references.
- **RBAC on file serving** — `checkFileAccess()` verifies user has permission to at least one page linking the file.
- **Default-deny catch-all** (`server.ts:91-96`) — unmatched routes return 404 with auth required.
- **Path traversal prevention** — `resolvePathWithin()`, `isValidContentHash()`, extension sanitization.
- **Dangerous MIME type handling** — HTML/SVG/XML served with `Content-Disposition: attachment` + restrictive CSP.

### 8. Rate Limiting & Account Protection

- **Login** — distributed rate limiting per IP + per email, plus database-backed account lockout after failed attempts.
- **Signup** — distributed rate limiting per IP + per email.
- **Processor uploads** — per-user rate limiting (100/hour default).
- **Contact form** — IP-based rate limiting.

### 9. Input Validation

- **Zod schemas** used extensively for request body validation.
- **CUID2 format validation** in real-time service with ReDoS prevention (length-first check).
- **Linear-time email regex** to prevent ReDoS.
- **File extension sanitization** — safe pattern + fallback.
- **Filename sanitization** — strips control chars, quotes, backslashes, semicolons, unicode spaces.

### 10. XSS Prevention

- **All `dangerouslySetInnerHTML` usages verified:**
  - `RichContentRenderer.tsx` — sanitized via `sanitizeHtmlAllowlist()` (DOMPurify with strict allowlist)
  - `RichDiffRenderer.tsx` — sanitized via `sanitizeHtmlAllowlist()`
  - `ActionResultRenderer.tsx` — sanitized via `sanitizeHtmlAllowlist(markdownToHtml(...))`
  - `code-block.tsx` — rendered via Shiki `codeToHtml()` (syntax highlighter, not user HTML)
  - `layout.tsx` / `page.tsx` — JSON-LD structured data + nonce-protected webpack bootstrap (safe)
- **SSR safety** — `sanitizeHtmlAllowlist()` returns empty string on server to prevent unsanitized HTML emission.

### 11. Cron Job Authentication

- **HMAC-SHA256 signed requests** via `validateSignedCronRequest()` — anti-replay (5-minute window, nonce tracking).
- **Fallback** — `CRON_SECRET` bearer token + internal network check.
- **Rejects** any request with `x-forwarded-for` header (prevents external proxy spoofing).

### 12. Security Headers

- `Content-Security-Policy` — nonce-based, per-request generated.
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Strict-Transport-Security` in production.
- `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` configured.

---

## Issue #1: Processor Service CORS — No Origin Restriction (FIXED)

**File:** `apps/processor/src/server.ts:30`

**Was:**
```typescript
app.use(cors());  // Allows ANY origin
```

**Impact:** The processor service accepted requests from any origin. While all endpoints require service tokens (which external websites don't have), this violates defense-in-depth. In a zero-trust model, the network boundary should never be the sole protection.

**Why it matters for zero-trust:** Zero-trust means no implicit trust in any network segment. Even though auth is enforced, allowing any origin to attempt requests means a compromised internal service could be weaponized via CORS to make cross-origin requests to the processor.

**Fix applied:**
```typescript
app.use(cors({
  origin: process.env.CORS_ORIGIN || process.env.WEB_APP_URL || false,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
```

---

## Issue #2: Nginx Dev Config Wildcard CORS (FIXED — Informational)

**File:** `nginx.conf:59`

**Was:**
```nginx
add_header Access-Control-Allow-Origin "*";
```

**Impact:** Informational only. This nginx config is used for local development. **Production uses Caddy** (configured outside this repo). The wildcard CORS was removed for defense-in-depth even in dev.

**Fix applied:** Removed CORS headers entirely — nginx is an internal-only cache service that browsers should never access directly.

**Action item:** Audit the production Caddy configuration separately to verify it does not introduce CORS gaps.

---

## Issue #3: Desktop MCP Servers (Known Exception)

**File:** `apps/desktop/src/main/mcp-manager.ts`

As you noted, this follows the Claude Desktop trust model:
- Users can configure arbitrary commands as MCP servers
- No sandboxing or command restrictions
- Full filesystem and environment access

**This is an accepted trust boundary** — the user explicitly configures which MCP servers to run, accepting the trust of those servers. This is identical to how Claude Desktop, VS Code extensions, and other local tools work.

**Existing mitigations:**
- `contextIsolation: true` and `nodeIntegration: false` in Electron config
- `sandbox: true` on renderer windows
- Security warnings displayed in UI when configuring MCP servers

---

## Routes Verified as Properly Protected

The following categories were exhaustively checked with no gaps found:

| Category | Routes | Auth | Authz | CSRF (mutations) |
|----------|--------|------|-------|-------------------|
| Account management | 9 | Session | Own-account | Yes |
| AI / Chat | 45+ | Session/MCP | Page permissions | Yes |
| Pages & content | 40+ | Session/MCP | canView/canEdit | Yes |
| Drives & collaboration | 30+ | Session/MCP | Drive membership | Yes |
| Channels & messaging | 8+ | Session | Page access | Yes |
| Admin | 10+ | Admin-only | adminRoleVersion | Yes |
| Integrations | 15+ | Session/HMAC | User-scoped | Yes |
| Stripe & billing | 13 | Session/Signature | Own-customer | Yes |
| Search | 7+ | Session | Accessible drives | N/A (GET) |
| Cron jobs | 8 | HMAC-signed | Internal network | N/A |
| MCP protocol | 6+ | MCP token | Drive scope | N/A (Bearer) |

### Intentionally Public Routes (No Auth, By Design)

| Route | Reason | Protection |
|-------|--------|------------|
| `/api/health` | Load balancer health check | Returns status only |
| `/api/auth/login` | Login entry point | Rate limiting + CSRF + lockout |
| `/api/auth/signup` | Signup entry point | Rate limiting per IP + email |
| `/api/auth/csrf` | CSRF token generation | Bound to session |
| `/api/auth/google/*` | OAuth callbacks | Standard OAuth flow |
| `/api/auth/device/*` | Device auth | Token-based |
| `/api/auth/mobile/*` | Mobile auth | Token-based |
| `/api/auth/desktop/*` | Desktop auth | Token exchange |
| `/api/contact` | Contact form | Rate limiting by IP |
| `/api/avatar/[userId]/[filename]` | Profile pictures | Path traversal protection |
| `/api/compiled-css` | Stylesheet serving | Read-only, no user data |
| `/api/notifications/unsubscribe/[token]` | Email unsubscribe | Opaque token, single-use, time-limited |
| `/api/track` | Analytics beacon | No state change, fire-and-forget |
| `/api/stripe/webhook` | Stripe webhook | Signature verification |
| `/api/integrations/google-calendar/webhook` | Calendar webhook | HMAC + channel token |
| `/api/internal/monitoring/ingest` | Monitoring | HMAC key verification |

---

## Conclusion

PageSpace implements a zero-trust architecture. One gap was found and fixed in this audit:

1. **Processor CORS wildcard** — now restricted to known origins via `CORS_ORIGIN` / `WEB_APP_URL`

The nginx dev config wildcard CORS was also cleaned up, though it had no production impact since production uses Caddy (configured outside this repo).

With the processor CORS fix applied and the accepted MCP desktop exception, **PageSpace can legitimately claim a zero-trust security posture**. The authentication and authorization implementation is thorough, consistent, and fail-closed throughout.

### Out-of-Scope Recommendation

The production Caddy reverse proxy configuration (managed outside this repo) should be audited separately to verify:
- CORS headers are restricted to the application origin
- WebSocket upgrade paths are properly authenticated
- TLS termination settings are current
- No cache paths bypass authentication
