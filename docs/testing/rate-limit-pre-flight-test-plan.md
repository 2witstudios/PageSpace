# Rate Limit Pre-Flight Check Test Plan

## Overview

This document provides a comprehensive test plan for the pre-flight rate limit checks implemented in both AI endpoints (Global AI and Page AI).

## What Was Fixed

**Problem:** Users at their daily quota (20/20 calls) could still send messages and receive AI responses because usage tracking only happened in the `onFinish` callback after streaming completed.

**Solution:** Added pre-flight rate limit checks using `getCurrentUsage()` before streaming starts in both endpoints.

## Implementation Details

### Global AI Endpoint
**File:** `/apps/web/src/app/api/ai_conversations/[id]/messages/route.ts`
**Lines:** 324-360

### Page AI Endpoint
**File:** `/apps/web/src/app/api/ai/chat/route.ts`
**Lines:** 344-380

### Rate Limit Logic

Both endpoints now:
1. Check if provider is `pagespace` (rate limiting only applies to PageSpace provider)
2. Determine `providerType` based on model:
   - `glm-4.6` → `pro` provider type
   - All other models → `standard` provider type
3. Call `getCurrentUsage(userId, providerType)` to check quota
4. If `!currentUsage.success` OR `currentUsage.remainingCalls <= 0`:
   - Return `createRateLimitResponse(providerType, limit)` with 429 status
   - Includes headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After`
5. If quota available, proceed with streaming

### Rate Limits by Tier

**Standard Provider (glm-4.5-air and other standard models):**
- Free: 20 calls/day
- Pro: 100 calls/day
- Business: 500 calls/day

**Pro Provider (glm-4.6 model):**
- Free: 0 calls/day (blocked)
- Pro: 50 calls/day
- Business: 100 calls/day

## Test Scenarios

### Test 1: User at 19/20 sends message (should work)

**Setup:**
- User subscription: Free tier
- Provider: PageSpace
- Model: glm-4.5-air (standard)
- Current usage: 19/20

**Expected Result:**
- ✅ Message accepted
- ✅ AI response streams successfully
- ✅ Usage incremented to 20/20 in onFinish
- ✅ Response includes content

**How to Test:**
1. Use database to set user's daily usage to 19
2. Send message via Global AI or Page AI
3. Verify message goes through
4. Check database shows 20/20 after completion

### Test 2: User at 20/20 sends message (should be blocked)

**Setup:**
- User subscription: Free tier
- Provider: PageSpace
- Model: glm-4.5-air (standard)
- Current usage: 20/20

**Expected Result:**
- ❌ Message blocked before streaming
- ❌ No AI response generated
- ❌ 429 HTTP status returned
- ✅ Error response includes:
  - `error: 'Rate limit exceeded'`
  - `message: 'Daily AI call limit exceeded...'`
  - `limit: 20`
  - `resetTime: <tomorrow midnight UTC>`
  - `upgradeUrl: '/settings/billing'`
- ✅ Response headers include:
  - `X-RateLimit-Limit: 20`
  - `X-RateLimit-Remaining: 0`
  - `X-RateLimit-Reset: <timestamp>`
  - `Retry-After: <seconds>`

**How to Test:**
1. Use database to set user's daily usage to 20
2. Send message via Global AI or Page AI
3. Verify 429 response returned
4. Verify no AI response generated
5. Check response body and headers

**SQL to set usage:**
```sql
-- Set user to 20/20 standard calls
INSERT INTO ai_usage_daily (user_id, date, provider_type, count, created_at, updated_at)
VALUES ('USER_ID', CURRENT_DATE, 'standard', 20, NOW(), NOW())
ON CONFLICT (user_id, date, provider_type)
DO UPDATE SET count = 20, updated_at = NOW();
```

### Test 3: User tries retry at 20/20 (should be blocked)

**Setup:**
- User subscription: Free tier
- Provider: PageSpace
- Model: glm-4.5-air (standard)
- Current usage: 20/20
- User clicks retry button on a previous message

**Expected Result:**
- ❌ Retry blocked before streaming
- ❌ 429 HTTP status returned
- ✅ Same error response as Test 2

**How to Test:**
1. Set user to 20/20 via database
2. Click retry button in UI
3. Verify 429 response
4. Verify usage stays at 20/20

### Test 4: Concurrent requests at 19/20 (race condition test)

**Setup:**
- User subscription: Free tier
- Provider: PageSpace
- Model: glm-4.5-air (standard)
- Current usage: 19/20
- Send two requests simultaneously

**Expected Behavior:**
- ✅ Both requests pass pre-flight check (both see 19/20)
- ✅ Both requests start streaming
- ✅ First onFinish increments to 20/20 ✅
- ✅ Second onFinish attempts increment but fails atomic SQL check
- ✅ Second message streams but doesn't increment quota
- ⚠️ User gets one "free" response (acceptable race condition)

**Notes:**
- This is an acceptable edge case
- The atomic SQL prevents going over limit
- Pre-flight checks prevent most overages
- Only happens in rare concurrent scenarios

**How to Test:**
1. Set user to 19/20
2. Send two messages at exact same time (use scripts)
3. Verify both responses stream
4. Check final usage is 20/20 (not 21/20)

### Test 5: Non-PageSpace provider (should not be rate limited)

**Setup:**
- User subscription: Free tier
- Provider: OpenRouter / Google / OpenAI / etc.
- User's own API key configured
- PageSpace usage: 20/20

**Expected Result:**
- ✅ Message accepted (no rate limit check)
- ✅ AI response streams successfully
- ✅ PageSpace usage stays at 20/20
- ✅ No 429 error

**How to Test:**
1. Set user to 20/20 PageSpace usage
2. Switch provider to OpenRouter with valid API key
3. Send message
4. Verify message goes through
5. Verify PageSpace usage unchanged

### Test 6: Pro model on free tier (should be blocked by pro check, not pre-flight)

**Setup:**
- User subscription: Free tier
- Provider: PageSpace
- Model: glm-4.6 (pro model)
- Current usage: 0/0 (pro provider)

**Expected Result:**
- ❌ Blocked by pro subscription check (different from rate limit)
- ❌ Returns subscription required error (not 429)
- ✅ Message: "Pro or Business subscription required"

**Note:** This is handled by `requiresProSubscription()` check, not the pre-flight rate limit check.

**How to Test:**
1. Free tier user
2. Select glm-4.6 model
3. Send message
4. Verify subscription required error (not rate limit error)

### Test 7: Pro tier user at 100/100 standard calls (should be blocked)

**Setup:**
- User subscription: Pro tier
- Provider: PageSpace
- Model: glm-4.5-air (standard)
- Current usage: 100/100

**Expected Result:**
- ❌ Message blocked before streaming
- ❌ 429 HTTP status returned
- ✅ Error shows limit: 100

**How to Test:**
1. Set user to Pro tier
2. Set standard usage to 100/100
3. Send message
4. Verify 429 with limit: 100

### Test 8: Pro tier user at 50/50 pro calls (should be blocked)

**Setup:**
- User subscription: Pro tier
- Provider: PageSpace
- Model: glm-4.6 (pro)
- Current usage: 50/50 (pro provider)

**Expected Result:**
- ❌ Message blocked before streaming
- ❌ 429 HTTP status returned
- ✅ Error shows limit: 50

**How to Test:**
1. Set user to Pro tier
2. Set pro provider usage to 50/50
3. Select glm-4.6 model
4. Send message
5. Verify 429 with limit: 50

### Test 9: Business tier user at 500/500 standard calls (should be blocked)

**Setup:**
- User subscription: Business tier
- Provider: PageSpace
- Model: glm-4.5-air (standard)
- Current usage: 500/500

**Expected Result:**
- ❌ Message blocked before streaming
- ❌ 429 HTTP status returned
- ✅ Error shows limit: 500

**How to Test:**
1. Set user to Business tier
2. Set standard usage to 500/500
3. Send message
4. Verify 429 with limit: 500

### Test 10: Reset at midnight UTC (quota refresh)

**Setup:**
- User at 20/20 standard calls
- Current date: 2025-01-15
- Wait until midnight UTC (date changes to 2025-01-16)

**Expected Result:**
- ✅ After midnight UTC, quota resets to 0/20
- ✅ User can send messages again
- ✅ Database has new row for new date

**How to Test:**
1. Set user to 20/20 for today
2. Change system time to 23:59:59 UTC
3. Wait 2 seconds
4. Send message
5. Verify it works (new date, new quota)

## Manual Testing Procedure

### Prerequisites
- Development environment running
- Database access (Drizzle Studio or psql)
- Browser DevTools open
- User accounts at different subscription tiers

### Step-by-Step Manual Test

1. **Prepare test user:**
```sql
-- Get your user ID
SELECT id, email, subscription_tier FROM users WHERE email = 'your-email@example.com';

-- Set user to 19/20 standard calls for today
INSERT INTO ai_usage_daily (user_id, date, provider_type, count, created_at, updated_at)
VALUES ('YOUR_USER_ID', CURRENT_DATE, 'standard', 19, NOW(), NOW())
ON CONFLICT (user_id, date, provider_type)
DO UPDATE SET count = 19, updated_at = NOW();
```

2. **Test at 19/20 (should work):**
   - Open Global Assistant or Page AI
   - Send message: "Hello, test message"
   - ✅ Verify response received
   - Check database: `SELECT * FROM ai_usage_daily WHERE user_id = 'YOUR_USER_ID' AND date = CURRENT_DATE;`
   - ✅ Verify count is now 20

3. **Test at 20/20 (should block):**
   - Send another message: "This should be blocked"
   - ✅ Verify 429 error shown in UI
   - ✅ Check browser Network tab for 429 status
   - ✅ Check response body includes rate limit info
   - ✅ Verify no AI response generated
   - Check database: `SELECT * FROM ai_usage_daily WHERE user_id = 'YOUR_USER_ID' AND date = CURRENT_DATE;`
   - ✅ Verify count is still 20 (not 21)

4. **Test retry at 20/20 (should block):**
   - Find previous message with retry button
   - Click retry
   - ✅ Verify 429 error
   - ✅ Verify count stays at 20

5. **Test with different provider:**
   - Switch to OpenRouter with your API key
   - Send message: "Test with OpenRouter"
   - ✅ Verify message goes through despite PageSpace being at 20/20
   - Check database: `SELECT * FROM ai_usage_daily WHERE user_id = 'YOUR_USER_ID' AND date = CURRENT_DATE;`
   - ✅ Verify PageSpace count stays at 20

6. **Reset for tomorrow:**
```sql
-- Manually reset for testing (or wait until midnight UTC)
DELETE FROM ai_usage_daily WHERE user_id = 'YOUR_USER_ID' AND date = CURRENT_DATE;
```

## Automated Testing

### Unit Test for getCurrentUsage()

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { getCurrentUsage, incrementUsage } from '@/lib/subscription/usage-service';

describe('AI Rate Limit Pre-Flight', () => {
  it('getCurrentUsage returns correct remaining calls', async () => {
    const userId = 'test-user-id';

    // Set up user with 19/20 usage
    await setupTestUser(userId, 19);

    const usage = await getCurrentUsage(userId, 'standard');

    expect(usage.success).toBe(true);
    expect(usage.currentCount).toBe(19);
    expect(usage.limit).toBe(20);
    expect(usage.remainingCalls).toBe(1);
  });

  it('getCurrentUsage returns no remaining calls at limit', async () => {
    const userId = 'test-user-id';

    // Set up user with 20/20 usage
    await setupTestUser(userId, 20);

    const usage = await getCurrentUsage(userId, 'standard');

    expect(usage.success).toBe(false);
    expect(usage.currentCount).toBe(20);
    expect(usage.limit).toBe(20);
    expect(usage.remainingCalls).toBe(0);
  });
});
```

### Integration Test for API Endpoints

```typescript
describe('AI Endpoint Rate Limiting', () => {
  it('blocks request at quota limit', async () => {
    // Set user to 20/20
    await setUserUsage(testUserId, 20);

    // Attempt to send message
    const response = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({
        chatId: testPageId,
        messages: [{ role: 'user', content: 'Test message' }],
        selectedProvider: 'pagespace',
        selectedModel: 'glm-4.5-air'
      })
    });

    expect(response.status).toBe(429);
    const data = await response.json();
    expect(data.error).toBe('Rate limit exceeded');
    expect(data.limit).toBe(20);
  });

  it('allows request below quota limit', async () => {
    // Set user to 19/20
    await setUserUsage(testUserId, 19);

    // Attempt to send message
    const response = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({
        chatId: testPageId,
        messages: [{ role: 'user', content: 'Test message' }],
        selectedProvider: 'pagespace',
        selectedModel: 'glm-4.5-air'
      })
    });

    expect(response.status).toBe(200);
    // Verify streaming response
  });
});
```

## Log Verification

When testing, check server logs for these emoji indicators:

**Pre-flight check started:**
```
🚦 Global Assistant Chat API: Checking rate limit before streaming
🚦 AI Chat API: Checking rate limit before streaming
```

**Rate limit exceeded:**
```
🚫 Global Assistant Chat API: Rate limit exceeded
🚫 AI Chat API: Rate limit exceeded
```

**Rate limit check passed:**
```
✅ Global Assistant Chat API: Rate limit check passed
✅ AI Chat API: Rate limit check passed
```

## Success Criteria

All tests pass when:
- ✅ Users at quota receive 429 before streaming
- ✅ Users below quota can send messages
- ✅ Non-PageSpace providers are not rate limited
- ✅ Concurrent requests don't exceed quota significantly
- ✅ Retry respects rate limits
- ✅ Different tiers have different limits enforced
- ✅ Quota resets at midnight UTC
- ✅ Error responses include proper headers and upgrade URL

## Known Edge Cases

### Race Condition (Acceptable)
When two requests arrive simultaneously at 19/20:
- Both pass pre-flight check
- Both start streaming
- First onFinish increments to 20/20
- Second onFinish fails atomic check
- User gets one "free" response
- This is acceptable and rare

### Why This Is Acceptable:
1. Pre-flight prevents 99% of overages
2. Atomic SQL prevents persistent over-limit state
3. Race condition is rare (requires exact simultaneous requests)
4. Alternative (locking) would add complexity and latency
5. One extra response is negligible cost

## Rollback Plan

If rate limiting causes issues:

1. **Quick fix:** Comment out pre-flight checks in both endpoints
2. **Revert commits:** Revert the changes to both route files
3. **Disable provider:** Set PageSpace provider as unavailable temporarily

## Related Documentation

- [Database-First AI Architecture](/docs/3.0-guides-and-tools/database-first-ai-architecture.md)
- [Database-First AI Testing Guide](/docs/testing/database-first-ai-testing-guide.md)
- [Usage Service Implementation](/apps/web/src/lib/subscription/usage-service.ts)
- [Rate Limit Middleware](/apps/web/src/lib/subscription/rate-limit-middleware.ts)
