# Zero-Trust Permission Mutations Design

**Date**: 2026-01-26
**Status**: Ready for Implementation
**Branch**: `critical-zero-trust-refactor-of-permission-writes-grant/revoke/share`

## Problem Statement

The current permission mutation functions (`grantPagePermissions`, `revokePagePermissions`) in `packages/lib/src/permissions/permissions.ts` accept a `grantedBy` parameter that is trusted blindly. This allows caller-trust where any code can:

1. Spoof the granter identity
2. Bypass authorization checks
3. Grant permissions without proving they have share rights

This violates zero-trust principles. The Elliott Test: "If someone imports `grantPagePermissions` directly and calls it, bypassing all routes and services, can they grant themselves admin access?" Currently: **Yes**.

## Solution Architecture

### Core Principle: Verify at the Point of Mutation

Security checks happen at the last possible moment before the side effect (DB write), not at some earlier point where the result is "remembered."

### Layer Responsibilities

```
Route Handler
  ↓ (extracts session → creates EnforcedAuthContext)
Service Layer
  ↓ (orchestration, batch ops, cache invalidation, audit logging)
  ↓ (passes ctx through, may add domain-specific checks)
Library Layer
  ↓ (Zod validation, authorization check, DB write)
Database
```

**Library layer** (zero-trust boundary):
- Zod schema validation (UUID format, structure)
- Business rule validation (permission combinations, self-grant prevention)
- Authorization check: does `ctx.userId` have share rights?
- Target user existence validation
- Single atomic DB operation

**Service layer**:
- Orchestration (batch operations, partial failure handling)
- Domain-specific business rules
- Cache invalidation
- Activity logging coordination

## API Design

### Function Signatures

```typescript
// packages/lib/src/permissions/permission-mutations.ts

async function grantPagePermission(
  ctx: EnforcedAuthContext,
  input: unknown
): Promise<GrantResult>;

async function revokePagePermission(
  ctx: EnforcedAuthContext,
  input: unknown
): Promise<RevokeResult>;
```

Key properties:
- `input: unknown` forces Zod parsing inside the function
- `ctx: EnforcedAuthContext` cannot be spoofed (private constructor, frozen)
- No `grantedBy` parameter — derived from `ctx.userId`

### Error Types

```typescript
type PermissionMutationError =
  | { code: 'VALIDATION_FAILED'; issues: z.ZodIssue[] }
  | { code: 'INVALID_PERMISSION_COMBINATION'; message: string }
  | { code: 'PAGE_NOT_ACCESSIBLE'; pageId: string }
  | { code: 'USER_NOT_FOUND'; userId: string }
  | { code: 'INSUFFICIENT_PERMISSION'; required: 'share' | 'admin' }
  | { code: 'SELF_PERMISSION_DENIED'; reason: string };
```

Error philosophy:
- Authorization failures are **expected**, not exceptional (Result, not throw)
- `PAGE_NOT_ACCESSIBLE` is intentionally ambiguous (prevents info leakage)
- Thrown exceptions only for invariant violations and unrecoverable states

### Result Types

```typescript
type GrantResult =
  | { ok: true; data: { permissionId: string; isUpdate: boolean } }
  | { ok: false; error: PermissionMutationError };

type RevokeResult =
  | { ok: true; data: { revoked: true; permissionId: string } }
  | { ok: true; data: { revoked: false; reason: 'not_found' } }
  | { ok: false; error: PermissionMutationError };
```

Revoke is idempotent: "permission no longer exists" is success regardless of prior state.

### Zod Schemas

```typescript
// packages/lib/src/permissions/schemas.ts

const UuidSchema = z.string().uuid();

const PermissionFlagsSchema = z.object({
  canView: z.boolean(),
  canEdit: z.boolean(),
  canShare: z.boolean(),
  canDelete: z.boolean(),
});

export const GrantInputSchema = z.object({
  pageId: UuidSchema,
  targetUserId: UuidSchema,
  permissions: PermissionFlagsSchema,
});

export const RevokeInputSchema = z.object({
  pageId: UuidSchema,
  targetUserId: UuidSchema,
});
```

Schema philosophy:
- Pure, synchronous, no I/O
- Validates structure/format only
- Business rules (e.g., "canView required for other permissions") live in function body

## Implementation Flow

### grantPagePermission

```
1. Parse (Zod) ─────────────────────────────────► VALIDATION_FAILED
     │
     ▼
2. Business Rules ──────────────────────────────► INVALID_PERMISSION_COMBINATION
     │                                            SELF_PERMISSION_DENIED
     ▼
3. Authorization (canUserSharePage) ────────────► PAGE_NOT_ACCESSIBLE
     │
     ▼
4. Target User Exists ──────────────────────────► USER_NOT_FOUND
     │
     ▼
5. Transaction (upsert) ────────────────────────► (DB errors throw)
     │
     ▼
6. Cache Invalidation
     │
     ▼
7. Audit Log (fire-and-forget)
     │
     ▼
Return Success
```

### revokePagePermission

```
1. Parse (Zod) ─────────────────────────────────► VALIDATION_FAILED
     │
     ▼
2. Business Rules ──────────────────────────────► SELF_PERMISSION_DENIED
     │
     ▼
3. Authorization (canUserSharePage) ────────────► PAGE_NOT_ACCESSIBLE
     │
     ▼
4. Find Permission
     │
     ├─► Not found ─────────────────────────────► { ok: true, revoked: false }
     │
     ▼
5. Delete Permission
     │
     ▼
6. Cache Invalidation
     │
     ▼
7. Audit Log (fire-and-forget, with previousValues)
     │
     ▼
Return Success
```

## Business Rules

### Permission Combination Validation

```typescript
function validatePermissionCombination(
  permissions: PermissionFlags
): PermissionMutationError | null {
  if (!permissions.canView &&
      (permissions.canEdit || permissions.canShare || permissions.canDelete)) {
    return {
      code: 'INVALID_PERMISSION_COMBINATION',
      message: 'Cannot grant edit/share/delete without view permission',
    };
  }
  return null;
}
```

### Self-Grant Prevention

```typescript
function validateNotSelfGrant(
  actorId: string,
  targetUserId: string
): PermissionMutationError | null {
  if (actorId === targetUserId) {
    return {
      code: 'SELF_PERMISSION_DENIED',
      reason: 'Cannot modify your own permissions',
    };
  }
  return null;
}
```

## Migration Strategy

**Hard cut, no deprecated wrappers.** A deprecated insecure function is still an insecure function.

### Timeline

1. **Create new functions** in `packages/lib/src/permissions/permission-mutations.ts`
2. **Single PR**: Migrate all callsites
   - `apps/web/src/services/api/permission-management-service.ts`
   - All tests in `packages/lib/src/__tests__/`
3. **Remove old exports** from `packages/lib/src/server.ts`
4. **Delete old functions** from `packages/lib/src/permissions/permissions.ts`

### Breaking Change

This is intentionally a breaking change. If something breaks, it should break loudly — that means insecure code was still being used.

## Test Requirements

### Validation Tests
- [ ] Invalid pageId UUID rejected
- [ ] Invalid targetUserId UUID rejected
- [ ] No DB query on validation failure (spy assertion)
- [ ] Validate before auth check (ordering verification)

### Authorization Tests
- [ ] Actor lacks share permission → PAGE_NOT_ACCESSIBLE
- [ ] grantedBy cannot be spoofed (ctx.userId used)
- [ ] Auth check before existence check (ordering verification)

### Business Rule Tests
- [ ] Self-grant rejected → SELF_PERMISSION_DENIED
- [ ] Invalid permission combination → INVALID_PERMISSION_COMBINATION

### Existence Tests
- [ ] Non-existent page → PAGE_NOT_ACCESSIBLE
- [ ] Non-existent target user → USER_NOT_FOUND

### Security Tests
- [ ] No info leakage: same error for missing vs forbidden page
- [ ] EnforcedAuthContext cannot be forged at runtime

### Revoke Tests
- [ ] Idempotent success when permission doesn't exist
- [ ] previousValues captured in audit log

### Side Effect Tests
- [ ] Cache invalidation on success
- [ ] Audit log on success
- [ ] No audit log on authorization failure

## Files to Create/Modify

### New Files
- `packages/lib/src/permissions/permission-mutations.ts` — New secure functions
- `packages/lib/src/permissions/schemas.ts` — Zod schemas
- `packages/lib/src/permissions/__tests__/permission-mutations.test.ts` — Tests

### Modified Files
- `packages/lib/src/permissions/index.ts` — Export new functions
- `packages/lib/src/permissions/permissions.ts` — Remove old functions
- `packages/lib/src/server.ts` — Update exports
- `apps/web/src/services/api/permission-management-service.ts` — Use new functions

### Helper Functions
- `getPageIfCanShare(userId, pageId)` — Combined existence + auth check
- `invalidatePermissionCache(userId, pageId)` — Cache invalidation

## Definition of Done

- [ ] All tests pass (including new security tests)
- [ ] No remaining call path can grant permissions without EnforcedAuthContext
- [ ] Old functions removed (no deprecated wrappers)
- [ ] Audit logging captures previousValues for rollback support
- [ ] TypeScript compilation succeeds with no `any` types
- [ ] The Elliott Test passes: direct import cannot bypass authorization

## Implementation Tasks

1. **Create schemas** (`schemas.ts`)
2. **Create error types and result types**
3. **Implement `grantPagePermission`**
4. **Implement `revokePagePermission`**
5. **Create helper `getPageIfCanShare`**
6. **Write tests** (full matrix)
7. **Update service layer** to use new functions
8. **Update existing tests** to use EnforcedAuthContext
9. **Remove old functions and exports**
10. **Verify no remaining insecure callsites**
