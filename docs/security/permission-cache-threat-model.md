# Permission Cache Threat Model

## Overview

PageSpace caches permission lookups in a two-tier cache (in-memory L1 + Redis L2) with a 60-second TTL. This document analyzes the security implications of the stale window and records the decision to accept this tradeoff.

---

## 1. Threat: Stale Permission Grant

**Scenario:** A user's permissions on a page are revoked (or downgraded). The previous, more-permissive permission entry remains in cache for up to 60 seconds.

**Attack window:** During that 60s window, the user could still perform actions their cached permissions allow.

### 1.1. Mitigations

1. **Proactive cache invalidation.** When permissions are mutated via `grantPagePermission` or `revokePagePermission`, both `invalidateUserCache(userId)` and `invalidateDriveCache(driveId)` are called immediately. Under normal operation, stale entries are removed within milliseconds of the mutation.

2. **`bypassCache: true` on write operations.** All destructive or mutation endpoints (page edit, delete, trash, bulk operations, permission management, file uploads, channel messages) bypass the cache entirely and query the database directly. The 60s stale window only affects read operations.

3. **Real-time per-event re-authorization.** The Socket.IO realtime service uses `bypassCache: true` for every write event (`document_update`, `page_content_change`, `page_delete`, `page_move`, `file_upload`). The stale window for realtime writes is 0 seconds.

4. **Natural TTL expiration.** Even if invalidation fails (Redis down, network error), the stale entry expires after 60 seconds.

5. **Error = deny.** Database errors during permission checks return `null`, which maps to access denied. The system never grants access based on a failed lookup.

### 1.2. Residual Risk

After all mitigations, the residual risk is:

- A user whose permissions were just revoked can **read** (not write) a page for up to 60 seconds, and only if cache invalidation also failed.
- Under normal operation (invalidation succeeds), the stale window is effectively 0 seconds.

---

## 2. Threat: Cache Poisoning

**Scenario:** An attacker injects a false permission entry into the cache.

### 2.1. Mitigations

1. **Cache writes only occur from database query results.** There is no external API to write directly to the permission cache. Cache entries are only set after a successful database query in `permissions-cached.ts`.

2. **Redis is not exposed externally.** The Redis instance is internal to the deployment and not accessible from the public network.

3. **Cache keys are deterministic.** Keys follow the pattern `pagespace:perms:{page|drive}:{userId}:{resourceId}` and cannot be influenced by user input in a way that causes cross-user pollution.

### 2.2. Residual Risk

Negligible. Cache poisoning would require direct Redis access, which is equivalent to database access.

---

## 3. Threat: Cache Side-Channel (Timing)

**Scenario:** An attacker infers page existence or permission status from response timing differences between cache hits and misses.

### 3.1. Mitigations

1. **Page existence is already revealed by the API.** The permission check returns 403 (forbidden) vs 404 (not found), but `getPageIfCanShare` in permission mutations deliberately conflates these to prevent information leakage.

2. **Timing differences are sub-millisecond.** L1 cache hits vs database queries differ by ~1-5ms, which is within normal network jitter.

### 3.2. Residual Risk

Low. Timing side-channels are not a meaningful threat for this application's trust model.

---

## 4. Deployment Context

PageSpace is deployed on a local Mac Studio for a small, trusted user base. This context significantly reduces the blast radius of any cache-related vulnerability:

- **Small user count:** Permission changes are infrequent and affect known users.
- **Trusted network:** All access is from the local network or VPN.
- **Single operator:** The deployment operator has full visibility into all user activity via audit logs.
- **Low attack motivation:** No public-facing surface reduces attacker interest.

---

## 5. Decision Record

| Field | Value |
|---|---|
| **Decision** | Accept 60s TTL permission cache with `bypassCache` on writes |
| **Date** | 2026-02-08 |
| **Status** | Accepted |
| **Context** | Permission lookups are a hot path (~5-20 per page load). Caching reduces database load significantly. |
| **Alternatives Considered** | (1) No cache -- rejected due to N+1 query performance impact. (2) Shorter TTL (5s) -- rejected because 60s is already conservative and invalidation handles the common case. (3) Write-through invalidation only -- this is what we do, plus TTL as a safety net. |
| **Rationale** | The 60s stale window only affects read operations. Write operations bypass cache entirely. Cache invalidation handles the normal revocation path. The residual risk (stale reads for up to 60s when invalidation also fails) is acceptable for a local deployment with trusted users. |
| **Review Trigger** | Revisit if PageSpace moves to a multi-tenant cloud deployment or if user count exceeds 50. |
