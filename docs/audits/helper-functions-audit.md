# Helper Functions Audit Report

**Date:** 2025-12-21
**Scope:** PageSpace monorepo - packages/lib, apps/web, apps/processor, apps/realtime
**Branch:** claude/audit-helper-functions-S8n8o

---

## Executive Summary

This audit identified **14 orphaned functions**, **14+ duplicate implementations**, **10 missing helper patterns**, and **4 cases of underutilized helpers**. The most critical issues are:

1. **Duplicate file security functions** across packages/lib and apps/processor
2. **4 separate implementations of `formatBytes()`**
3. **12+ files with repeated IP extraction code**
4. **Orphaned device fingerprinting functions** (6+ unused)

---

## 1. Orphaned/Unused Helper Functions

### High Priority - Remove or Implement

| Function | Location | Status |
|----------|----------|--------|
| `subscriptionAllows()` | `packages/lib/src/services/subscription-utils.ts` | Never called |
| `requireResource()` | `packages/lib/src/services/service-auth.ts` | Never called |
| `parseBytes()` | `packages/lib/src/services/storage-limits.ts` | Never called |
| `mapSubscriptionToStorageTier()` | `packages/lib/src/services/storage-limits.ts` | Deprecated, never called |
| `setupMemoryProtection()` | `packages/lib/src/services/memory-monitor.ts` | Never called |
| `emergencyMemoryCleanup()` | `packages/lib/src/services/memory-monitor.ts` | Never called |
| `formatMemory()` | `packages/lib/src/services/memory-monitor.ts` | Never called |
| `parseDateUTC()` | `packages/lib/src/services/date-utils.ts` | Only used in tests |

### Device Fingerprinting (6 functions never used)

Location: `packages/lib/src/auth/device-fingerprint-utils.ts`

| Function | Purpose | Status |
|----------|---------|--------|
| `getClientIP()` | Extract client IP from headers | Only used internally |
| `detectPlatform()` | Detect platform from User-Agent | Only used internally |
| `calculateTrustScore()` | Calculate device trust score | Only tested |
| `isSameSubnet()` | Check if IPs on same /24 subnet | Only tested |
| `isRapidRefresh()` | Detect rapid token refresh | Only tested |
| `anonymizeIP()` | Anonymize IP for privacy | Only tested |
| `extractDeviceMetadata()` | Extract device metadata from request | Never called |
| `generateDefaultDeviceName()` | Generate device name | Never called |
| `generateServerFingerprint()` | Generate server-side fingerprint | Never called |
| `validateDeviceFingerprint()` | Validate device fingerprint | Never called |

**Recommendation:** These appear to be part of an incomplete device security feature. Either implement the feature or remove the code.

---

## 2. Duplicate Helper Implementations

### Critical Priority

#### 2.1 File Security Functions (2 locations)

| Function | Location 1 | Location 2 |
|----------|------------|------------|
| `sanitizeFilename()` | `packages/lib/src/utils/file-security.ts:10-34` | `apps/processor/src/utils/security.ts:73-97` |
| `DANGEROUS_MIME_TYPES` | `packages/lib/src/utils/file-security.ts:39-45` | `apps/processor/src/utils/security.ts:102-108` |
| `isDangerousMimeType()` | `packages/lib/src/utils/file-security.ts:50-54` | `apps/processor/src/utils/security.ts:113-117` |

**Fix:** Consolidate into `packages/lib` and import in processor app.

#### 2.2 MCP Tool Converter (2 locations)

| Function | Web Location | Desktop Location |
|----------|--------------|------------------|
| `validateToolName()` | `apps/web/src/lib/ai/core/mcp-tool-converter.ts:28-42` | `apps/desktop/src/main/mcp-tool-converter.ts:37-51` |
| `validateServerName()` | `:49-63` | `:58-72` |
| `createSafeToolName()` | `:72-76` | `:81-85` |
| `jsonSchemaToZod()` | `:82-165` | `:91-174` |
| `convertMCPToolSchemaToZod()` | `:170-201` | `:181-233` |
| `parseMCPToolName()` | `:242-276` | `:276-310` |
| `isMCPTool()` | `:282-284` | **MISSING** |

**Fix:** Extract to `packages/lib` or create shared module.

### High Priority

#### 2.3 Byte Formatting (4 locations!)

```typescript
// Pattern repeated 4 times:
export function formatBytes(bytes: number): string {
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  if (bytes === 0) return '0 B';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${Math.round(bytes / Math.pow(1024, i) * 100) / 100} ${sizes[i]}`;
}
```

| Location | Line |
|----------|------|
| `apps/web/src/lib/utils/utils.ts` | 19-29 |
| `packages/lib/src/services/storage-limits.ts` | 359-364 |
| `packages/lib/src/services/subscription-utils.ts` | 96-101 |
| `packages/lib/src/client-safe.ts` | 29-34 |

**Fix:** Keep single implementation in `packages/lib/src/client-safe.ts`, remove others.

#### 2.4 Byte Parsing (2 locations)

| Location | Implementation |
|----------|---------------|
| `packages/lib/src/services/storage-limits.ts:369-388` | Uses map object |
| `packages/lib/src/client-safe.ts:37-58` | Uses switch statement |

**Fix:** Consolidate into `client-safe.ts`.

### Medium Priority

#### 2.5 Slugify Function (2 locations)

Both are identical implementations:

```typescript
export function slugify(text: string): string {
  return text
    .toString()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]+/g, '')
    .replace(/--+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}
```

| Location |
|----------|
| `packages/lib/src/utils/utils.ts:1-10` |
| `apps/web/src/lib/utils/utils.ts:8-17` |

**Fix:** Keep in `packages/lib`, re-export from web lib.

---

## 3. Missing Helpers (Repeated Inline Patterns)

### Critical Priority - Create These Helpers

#### 3.1 `getClientIP(request: Request): string`

**Current pattern (12 files):**
```typescript
const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0] ||
                 req.headers.get('x-real-ip') ||
                 'unknown';
```

**Files affected:**
- `apps/web/src/app/api/auth/signup/route.ts:41-43`
- `apps/web/src/app/api/auth/login/route.ts:44-46`
- `apps/web/src/app/api/auth/mobile/signup/route.ts:45-47`
- `apps/web/src/app/api/auth/device/refresh/route.ts:38-41`
- `apps/web/src/app/api/auth/refresh/route.ts:19-21`
- `apps/web/src/app/api/auth/mobile/login/route.ts:32-34`
- `apps/web/src/app/api/auth/mobile/refresh/route.ts`
- `apps/web/src/app/api/auth/google/callback/route.ts`
- `apps/web/src/app/api/auth/google/signin/route.ts`
- `apps/web/src/app/api/auth/logout/route.ts`
- `apps/web/src/app/api/account/devices/route.ts`
- `apps/web/src/app/api/auth/mobile/oauth/google/exchange/route.ts`

**Note:** `getClientIP()` exists in `device-fingerprint-utils.ts` but is NEVER IMPORTED!

#### 3.2 `createAuthTokenCookieHeaders(accessToken, refreshToken): Headers`

**Current pattern (6 files):**
```typescript
const accessTokenCookie = serialize('accessToken', accessToken, {
  httpOnly: true,
  secure: isProduction,
  sameSite: 'strict',
  path: '/',
  maxAge: 15 * 60,
  ...(isProduction && { domain: process.env.COOKIE_DOMAIN })
});

const refreshTokenCookie = serialize('refreshToken', refreshToken, {
  httpOnly: true,
  secure: isProduction,
  sameSite: 'strict',
  path: '/',
  maxAge: getRefreshTokenMaxAge(),
  ...(isProduction && { domain: process.env.COOKIE_DOMAIN })
});

const headers = new Headers();
headers.append('Set-Cookie', accessTokenCookie);
headers.append('Set-Cookie', refreshTokenCookie);
```

**Files affected:**
- `apps/web/src/app/api/auth/signup/route.ts:242-258`
- `apps/web/src/app/api/auth/login/route.ts:152-168`
- `apps/web/src/app/api/auth/device/refresh/route.ts:178-194`
- `apps/web/src/app/api/auth/refresh/route.ts:140-156`
- `apps/web/src/app/api/auth/mobile/signup/route.ts`
- `apps/web/src/app/api/auth/logout/route.ts`

#### 3.3 `handleValidationError(error, logger, defaultMessage): NextResponse`

**Current pattern (7+ files):**
```typescript
catch (error) {
  loggers.api.error('Error updating page:', error as Error);
  if (error instanceof z.ZodError) {
    return NextResponse.json({ error: error.issues }, { status: 400 });
  }
  return NextResponse.json({ error: 'Failed to update page' }, { status: 500 });
}
```

#### 3.4 `getPaginationParams(url, defaultLimit, maxLimit): { limit, offset }`

**Current pattern (10+ files):**
```typescript
const { searchParams } = new URL(request.url);
const limit = Math.min(parseInt(searchParams.get('limit') || '20'), 50);
```

#### 3.5 `createRateLimitResponse(rateLimitResult, message): Response`

**Current pattern (auth routes):**
```typescript
if (!ipRateLimit.allowed) {
  return Response.json(
    {
      error: 'Too many signup attempts from this IP address.',
      retryAfter: ipRateLimit.retryAfter
    },
    {
      status: 429,
      headers: { 'Retry-After': ipRateLimit.retryAfter?.toString() || '3600' }
    }
  );
}
```

#### 3.6 `calculateRefreshTokenExpiration(token): Promise<Date>`

**Current pattern (5 files):**
```typescript
const refreshPayload = await decodeToken(refreshToken);
const refreshExpiresAt = refreshPayload?.exp
  ? new Date(refreshPayload.exp * 1000)
  : new Date(Date.now() + getRefreshTokenMaxAge() * 1000);
```

---

## 4. Underutilized Helpers

### High Priority

#### 4.1 `serializeDates()` / `jsonResponse()` Not Used

**Files with manual `.toISOString()` calls:**

| File | Lines | Issue |
|------|-------|-------|
| `apps/web/src/app/api/account/devices/route.ts` | 46, 53-54 | Manual date serialization |
| `apps/web/src/app/api/messages/threads/route.ts` | 121-126, 203-205 | Multiple `.toISOString()` calls |
| `apps/web/src/app/api/stripe/invoices/route.ts` | 84, 86, 89 | Manual epoch to date conversion |
| `apps/web/src/app/api/stripe/upcoming-invoice/route.ts` | 98-101, 108-109 | Nested manual conversion |

**Current pattern:**
```typescript
lastUsedAt: (device.lastUsedAt || device.createdAt).toISOString()
```

**Should use:**
```typescript
import { jsonResponse } from '@pagespace/lib';
return jsonResponse(data); // Automatically serializes dates
```

### Medium Priority

#### 4.2 Local `formatBytes()` Instead of Import

**File:** `apps/web/src/app/dashboard/storage/page.tsx:103-108`

```typescript
// Current - local implementation
const formatBytes = (bytes: number): string => {
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  if (bytes === 0) return '0 B';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${Math.round(bytes / Math.pow(1024, i) * 100) / 100} ${sizes[i]}`;
};

// Should use
import { formatBytes } from '@pagespace/lib';
```

### Low Priority

#### 4.3 Manual Slugify in Test Files (8 locations)

Test files manually implement slug conversion instead of using `slugify()`:

- `apps/web/src/app/api/drives/__tests__/route.test.ts:73`
- `apps/web/src/app/api/drives/[driveId]/__tests__/route.test.ts:73, 88`
- `apps/web/src/app/api/drives/[driveId]/roles/__tests__/route.test.ts:52`
- `apps/web/src/app/api/drives/[driveId]/roles/reorder/__tests__/route.test.ts:48`
- `apps/web/src/app/api/drives/[driveId]/roles/[roleId]/__tests__/route.test.ts:54`
- `apps/web/src/app/api/drives/[driveId]/members/__tests__/route.test.ts:67`
- `apps/web/src/app/api/drives/[driveId]/members/[userId]/__tests__/route.test.ts:89`
- `apps/web/src/app/api/auth/__tests__/signup.test.ts:41`

---

## 5. Recommendations Summary

### Immediate Actions (Critical)

1. **Consolidate file security functions** into `packages/lib`
2. **Consolidate `formatBytes()`** - keep one in `client-safe.ts`
3. **Create `getClientIP()` helper** in `packages/lib/src/auth/` (or use existing unused one)
4. **Create `createAuthTokenCookieHeaders()`** in auth-utils

### Short-term Actions (High Priority)

5. **Remove orphaned functions** from subscription-utils, storage-limits, memory-monitor
6. **Consolidate MCP tool converter** into packages/lib
7. **Replace manual date serialization** with `jsonResponse()`
8. **Create validation error handler**

### Medium-term Actions

9. **Decide on device fingerprinting feature** - implement or remove
10. **Consolidate slugify** - single source of truth
11. **Create pagination params helper**
12. **Create rate limit response helper**

### Maintenance Actions (Low Priority)

13. **Update tests to use `slugify()`** helper
14. **Audit for additional duplication** quarterly

---

## Metrics

| Category | Count |
|----------|-------|
| Orphaned functions | 14 |
| Duplicate implementations | 14+ functions |
| Missing helper patterns | 10 |
| Underutilized helper cases | 4 |
| **Total issues** | **42+** |

---

## Appendix: Helper Function Map

See the full exploration output for a complete map of 80+ helper/utility files across the monorepo, organized by domain:

1. Authentication & Security (9 files)
2. Permissions & Access Control (3 files)
3. Content & Page Utilities (8 files)
4. Formatting & Display (6 files)
5. Database & Repository (9 files)
6. AI System Utilities (20+ files)
7. Logging & Monitoring (9 files)
8. WebSocket & Real-time (5 files)
9. Service Utilities (13 files)
10. Other domains (15+ files)
