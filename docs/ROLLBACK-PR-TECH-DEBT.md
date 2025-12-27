# Rollback PR Tech Debt

CodeRabbit review suggestions from PR `fix/rollback-activity-feed-issues` to address in future work.

**Priority**: Low - all suggestions are improvements, not bugs
**Status**: Deferred for future cleanup

---

## 1. Promise.all Mocking Fragility

**File:** `apps/web/src/services/api/__tests__/rollback-service.test.ts`
**Lines:** 914-918, 941-944, 1003-1006, 1028-1031
**Type:** Test improvement

**Issue:** Spying on `Promise.all` globally is fragile and can interfere with other concurrent tests.

**Fix:** Use counter pattern with `db.select` mock instead:

```typescript
// Instead of:
vi.spyOn(Promise, 'all').mockResolvedValueOnce([mockActivities, [{ value: 2 }]]);

// Use:
let selectCallCount = 0;
(db.select as Mock).mockImplementation(() => ({
  from: vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({
      orderBy: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          offset: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1) return Promise.resolve(mockActivities);
            return Promise.resolve([{ value: 2 }]);
          }),
        }),
      }),
    }),
  }),
}));
```

---

## 2. Force: true Test Coverage

**File:** `apps/web/src/app/api/ai/chat/messages/[messageId]/undo/__tests__/route.test.ts`
**Lines:** 319-320, 345-346
**Type:** Missing test coverage

**Issue:** Tests verify `force: false` default but don't test `force: true` scenarios.

**Add tests for:**
- Explicitly passing `force: true` in request body
- Scenarios where preview indicates `requiresForce: true`
- Behavior when forcing despite `hasConflict: true`
- Authorization checks when force is used

```typescript
it('accepts force: true to override conflicts', async () => {
  const previewWithConflict = createAiUndoPreview({
    activitiesAffected: [
      createAiUndoActivity({
        preview: createActionPreview({
          hasConflict: true,
          requiresForce: true,
          conflictFields: ['content'],
        }),
      }),
    ],
  });

  (previewAiUndo as Mock).mockResolvedValue(previewWithConflict);
  (executeAiUndo as Mock).mockResolvedValue({
    success: true,
    messagesDeleted: 3,
    activitiesRolledBack: 1,
    errors: [],
  });

  const response = await POST(
    createPostRequest({ mode: 'messages_and_changes', force: true }),
    { params: mockParams }
  );

  expect(response.status).toBe(200);
  expect(executeAiUndo).toHaveBeenCalledWith(
    mockMessageId,
    mockUserId,
    'messages_and_changes',
    expect.any(Object),
    expect.objectContaining({ force: true })
  );
});
```

---

## 3. Permission Update Mock Coverage

**File:** `apps/web/src/app/api/pages/[pageId]/permissions/__tests__/route.test.ts`
**Lines:** 61-69
**Type:** Test coverage gap

**Issue:** `pagePermissions.findFirst` mock always returns `null`, preventing `previousValues` code path from being exercised in update scenarios.

**Fix:** Add conditional mock in update test:

```typescript
it('returns 200 when updating existing permission', async () => {
  // Mock existing permission for update scenario
  vi.mocked(db.query.pagePermissions.findFirst).mockResolvedValueOnce({
    id: 'perm_123',
    pageId: mockPageId,
    userId: 'user_456',
    canView: false,
    canEdit: false,
    canShare: false,
    canDelete: false,
    grantedBy: 'owner_123',
    grantedAt: new Date(),
  });

  (permissionManagementService.grantOrUpdatePermission as Mock).mockResolvedValue({
    success: true,
    permission: mockPermission,
    isUpdate: true,
  });
  // ...
});
```

---

## 4. Idempotency Documentation

**File:** `apps/web/src/services/api/ai-undo-service.ts`
**Lines:** 379-401
**Type:** Documentation

**Issue:** Idempotency check assumes activities were also rolled back if message is inactive. This assumption should be documented.

**Fix:** Add comment:

```typescript
// Idempotency check: if message is already inactive, return success
// This prevents duplicate rollbacks on network retries or double-clicks
// Assumption: if message is inactive, any associated activities were also
// successfully rolled back in the previous attempt. This is safe for
// same-request retries but may not handle partial failure recovery.
if (!message.isActive) {
```

---

## 5. Force Flag Readability

**File:** `apps/web/src/services/api/ai-undo-service.ts`
**Lines:** 437-447
**Type:** Code clarity

**Issue:** Double-negative condition reduces readability.

**Fix:**

```typescript
// Current (hard to read):
if (!force || !activityPreview.requiresForce) {

// Clearer:
const canForce = force && activityPreview.requiresForce;
if (!canForce) {
  throw new Error(`Cannot undo ${activity.operation}...`);
}
```

---

## 6. Dual-Table Update Logging

**File:** `apps/web/src/services/api/ai-undo-service.ts`
**Lines:** 486-519
**Type:** Observability

**Issue:** Dual-table soft-delete works but doesn't log which table contained messages.

**Note:** Drizzle ORM may not return `rowCount`. Investigate if this is possible before implementing.

---

## 7. page-write-tools Test Assertions

**File:** `apps/web/src/lib/ai/tools/__tests__/page-write-tools.test.ts`
**Lines:** 244-250, 396-402
**Type:** Test explicitness

**Issue:** Tests use `objectContaining` but don't explicitly verify `operation` and `context` parameters.

**Fix:** Add explicit assertions:

```typescript
expect(mockApplyPageMutation).toHaveBeenCalledWith(
  expect.objectContaining({
    pageId: 'page-1',
    operation: 'update',  // Add this
    updates: { content: 'Line 1\nNew Line 2\nLine 3' },
    updatedFields: ['content'],
    context: expect.any(Object),  // Add this
  })
);
```

---

## Summary

| # | Issue | Priority | Effort |
|---|-------|----------|--------|
| 1 | Promise.all mocking | Low | Medium |
| 2 | Force: true tests | Low | Medium |
| 3 | Permission mock coverage | Low | Low |
| 4 | Idempotency docs | Low | Trivial |
| 5 | Force flag readability | Low | Trivial |
| 6 | Dual-table logging | Low | Low |
| 7 | page-write-tools assertions | Low | Trivial |

**Recommendation:** Address items 4, 5, 7 first (trivial effort), then tackle test improvements as time permits.
