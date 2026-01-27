# Zero-Trust Permission Mutations Implementation Log

**Plan**: `docs/plans/2026-01-26-zero-trust-permission-mutations-design.md`
**Branch**: `critical-zero-trust-refactor-of-permission-writes-grant/revoke/share`
**Status**: COMPLETE

## Implementation Checklist

### Phase 1: Core Types & Schemas
- [x] **Create Zod schemas** (`packages/lib/src/permissions/schemas.ts`)
  - [x] UuidSchema
  - [x] PermissionFlagsSchema
  - [x] GrantInputSchema
  - [x] RevokeInputSchema

- [x] **Create error types and result types** (`packages/lib/src/permissions/permission-mutations.ts`)
  - [x] PermissionMutationError discriminated union
  - [x] GrantResult type
  - [x] RevokeResult type

### Phase 2: Helper Functions
- [x] **Create getPageIfCanShare helper** (`packages/lib/src/permissions/permission-mutations.ts`)
  - [x] Combined existence + authorization check
  - [x] Returns PAGE_NOT_ACCESSIBLE for both missing and unauthorized (no info leak)

### Phase 3: Main Functions
- [x] **Implement grantPagePermission**
  - [x] Accept `ctx: EnforcedAuthContext` and `input: unknown`
  - [x] Zod validation (VALIDATION_FAILED)
  - [x] Business rules: validatePermissionCombination (INVALID_PERMISSION_COMBINATION)
  - [x] Business rules: validateNotSelfGrant (SELF_PERMISSION_DENIED)
  - [x] Authorization: getPageIfCanShare (PAGE_NOT_ACCESSIBLE)
  - [x] Target user existence check (USER_NOT_FOUND)
  - [x] DB upsert operation
  - [x] Cache invalidation
  - [x] Audit log (fire-and-forget)

- [x] **Implement revokePagePermission**
  - [x] Accept `ctx: EnforcedAuthContext` and `input: unknown`
  - [x] Zod validation (VALIDATION_FAILED)
  - [x] Business rules: validateNotSelfGrant (SELF_PERMISSION_DENIED)
  - [x] Authorization: getPageIfCanShare (PAGE_NOT_ACCESSIBLE)
  - [x] Find existing permission (idempotent: not_found is success)
  - [x] Delete permission if exists
  - [x] Cache invalidation
  - [x] Audit log with previousValues (fire-and-forget)

### Phase 4: Tests
- [x] **Write comprehensive test suite** (`packages/lib/src/permissions/__tests__/permission-mutations.test.ts`)
  - [x] Validation tests
  - [x] Authorization tests
  - [x] Business rule tests
  - [x] Existence tests
  - [x] Security tests
  - [x] Idempotency tests (revoke)
  - [x] Side effect tests (cache, audit)

### Phase 5: Migration
- [x] **Update API route** (`apps/web/src/app/api/pages/[pageId]/permissions/route.ts`)
  - [x] Added `authenticateWithEnforcedContext` helper to auth module
  - [x] POST handler uses `grantPagePermission` with zero-trust
  - [x] DELETE handler uses `revokePagePermission` with zero-trust

- [x] **Update existing tests to use factories**
  - [x] Updated `packages/lib/src/__tests__/permissions.test.ts`
  - [x] Updated `packages/lib/src/__tests__/multi-tenant-isolation.test.ts`
  - [x] Updated `packages/lib/src/__tests__/permissions-cached.test.ts`

- [x] **Remove old functions and exports**
  - [x] Removed from `packages/lib/src/permissions/permissions.ts`
  - [x] Removed from `packages/lib/src/permissions/index.ts`
  - [x] Removed from `packages/lib/src/server.ts`

- [x] **Verify no remaining insecure callsites**
  - [x] grep search confirms old functions removed
  - [x] TypeScript build passes
  - [x] All tests compile

### Phase 6: PR
- [x] **Create PR** (#257)
  - [x] PR created with complete description
  - [x] Addressed Codex review: UUID → CUID2 validation (database uses CUID2 IDs)
  - [x] Addressed CodeRabbit review: Race condition fix using insert-first pattern with `onConflictDoNothing`
  - [x] Merged real-time kick functionality from master (permission revocation kicks user from rooms)
  - [ ] Waiting for final CI checks

## File Paths

| Component | Path |
|-----------|------|
| Zod schemas | `packages/lib/src/permissions/schemas.ts` |
| New secure functions | `packages/lib/src/permissions/permission-mutations.ts` |
| Tests | `packages/lib/src/permissions/__tests__/permission-mutations.test.ts` |
| Permissions index | `packages/lib/src/permissions/index.ts` |
| Old permissions | `packages/lib/src/permissions/permissions.ts` |
| Server exports | `packages/lib/src/server.ts` |
| API Route | `apps/web/src/app/api/pages/[pageId]/permissions/route.ts` |
| Auth helper | `apps/web/src/lib/auth/index.ts` |

## Notes

### Key Design Decisions
1. **EnforcedAuthContext** - Cannot be constructed directly, only via `fromSession()`
2. **input: unknown** - Forces Zod parsing inside the function
3. **No grantedBy parameter** - Derived from `ctx.userId`
4. **Result types (not exceptions)** - Authorization failures are expected, not exceptional
5. **PAGE_NOT_ACCESSIBLE** - Intentionally ambiguous to prevent info leakage
6. **Idempotent revoke** - "Permission no longer exists" is success
7. **CUID2 validation** - Uses official `isCuid` validator (database uses CUID2 IDs, not UUIDs)
8. **Insert-first upsert** - Uses `onConflictDoNothing` to prevent race conditions in concurrent grants
9. **Real-time kick on revoke** - When permission is revoked, user is immediately kicked from WebSocket rooms

### Testing Strategy
- TDD approach where feasible
- Unit tests for pure functions (validation, business rules)
- Integration tests for DB operations
- Security tests for authorization bypass attempts
