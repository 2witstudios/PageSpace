# Rate Limiting Security Hardening Design

**Date:** 2026-01-26
**Status:** Implemented

## Overview

This design addresses security gaps in rate limiting by adding:
1. Rate limiting to the contact form endpoint
2. Rate limiting to the email resend endpoint
3. Database-backed account lockout for repeated failed logins

## Background

The existing distributed rate limiting infrastructure already implements fail-closed behavior in production when Redis is unavailable. However, several endpoints lacked rate limiting protection, and there was no persistent account lockout mechanism.

## Design Decisions

### 1. Contact Form Rate Limiting

**Configuration:** 5 submissions per hour per IP address

**Rationale:**
- Prevents spam/abuse of contact form
- IP-based limiting appropriate since endpoint allows unauthenticated access
- 5 per hour is generous for legitimate use while blocking abuse
- Uses existing `checkDistributedRateLimit` infrastructure

**Implementation:**
- Added `CONTACT_FORM` config to `DISTRIBUTED_RATE_LIMITS`
- Rate limit check added at start of POST handler
- Returns 429 with `Retry-After` header when blocked

### 2. Email Resend Rate Limiting

**Configuration:** 3 requests per hour per email address

**Rationale:**
- Prevents email bombing attacks
- Email-based (not IP-based) to prevent abuse regardless of IP changes
- 3 per hour is sufficient for legitimate use (email going to spam, etc.)
- Protects email sending infrastructure

**Implementation:**
- Added `EMAIL_RESEND` config to `DISTRIBUTED_RATE_LIMITS`
- Rate limit check after user lookup (need email address)
- Returns 429 with `Retry-After` header when blocked

### 3. Account Lockout Policy

**Configuration:**
- Lock after 10 consecutive failed login attempts
- Auto-unlock after 15 minutes

**Rationale:**
- Database-backed for persistence across restarts
- Provides per-account protection regardless of attacker IP changes
- 10 attempts balances security with user convenience
- 15-minute lockout is standard industry practice
- Complements (not replaces) IP-based rate limiting

**Database Schema Changes:**
```sql
ALTER TABLE users ADD COLUMN failedLoginAttempts INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE users ADD COLUMN lockedUntil TIMESTAMP WITH TIME ZONE;
```

**API Functions:**
- `getAccountLockoutStatus(userId)` - Check if account is locked
- `isAccountLockedByEmail(email)` - Check by email (for login flows)
- `recordFailedLoginAttempt(userId)` - Increment attempts, lock if threshold reached
- `recordFailedLoginAttemptByEmail(email)` - Same but by email
- `resetFailedLoginAttempts(userId)` - Clear on successful login
- `unlockAccount(userId)` - Admin manual unlock

## Files Changed

| File | Changes |
|------|---------|
| `packages/lib/src/security/distributed-rate-limit.ts` | Added `CONTACT_FORM`, `EMAIL_RESEND` configs |
| `packages/db/src/schema/auth.ts` | Added `failedLoginAttempts`, `lockedUntil` columns |
| `packages/lib/src/auth/account-lockout.ts` | New file with lockout logic |
| `packages/lib/src/auth/index.ts` | Export account lockout functions |
| `apps/web/src/app/api/contact/route.ts` | Added rate limiting |
| `apps/web/src/app/api/auth/resend-verification/route.ts` | Added rate limiting |

## Test Coverage

- Rate limit config tests in `distributed-rate-limit.test.ts`
- Account lockout unit tests in `account-lockout.test.ts`

## Migration Required

After merging, run:
```bash
pnpm db:generate
pnpm db:migrate
```

## Integration Notes

Auth routes should integrate account lockout by:
1. Checking `isAccountLockedByEmail()` before validating credentials
2. Calling `recordFailedLoginAttemptByEmail()` on authentication failure
3. Calling `resetFailedLoginAttempts()` on successful login

Example integration:
```typescript
// Check if locked before auth
const lockStatus = await isAccountLockedByEmail(email);
if (lockStatus.isLocked) {
  return Response.json({
    error: 'Account temporarily locked. Try again later.',
    lockedUntil: lockStatus.lockedUntil,
  }, { status: 423 });
}

// On failed auth
await recordFailedLoginAttemptByEmail(email);

// On successful auth
await resetFailedLoginAttempts(user.id);
```

## Security Considerations

- **Fail-closed:** All rate limiting denies requests when Redis unavailable in production
- **No information leak:** `recordFailedLoginAttemptByEmail` returns success even for non-existent users
- **Audit trail:** All lockout events are logged with user ID and email
- **Defense in depth:** Account lockout complements IP-based rate limiting
