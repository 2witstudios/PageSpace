# File Evolution: apps/web/src/components/admin/UsersTable.tsx

> Generated: 2026-01-22T14:52:05.328Z

## Summary

- **Total Commits**: 11
- **Lines Added**: 683
- **Lines Deleted**: 144
- **Net Change**: 539 lines

## Lifecycle Status

**✅ ACTIVE** - This file exists in the current codebase.

## Commit History

| Date | Commit | +/- | Message |
|------|--------|-----|---------|
| 2025-08-21 | `36a0d18f` | +285/-0 | Open Beta Init |
| 2025-09-17 | `a83c56e5` | +72/-1 | stripe payment |
| 2025-09-17 | `5bfaa1bb` | +39/-8 | billing, storage, rate limits all done now |
| 2025-09-21 | `d09a65c7` | +32/-11 | billing upgrade |
| 2025-09-21 | `243d04f4` | +7/-7 | Correct cloud subscription model |
| 2025-09-24 | `41c57ee2` | +30/-28 | Improve responsive layout across web app |
| 2025-10-08 | `0f828e3b` | +2/-13 | CSRF |
| 2025-11-28 | `005f17a6` | +1/-1 | refactor: reorganize packages/lib and apps/web/src/lib into  |
| 2025-12-12 | `2ffaf60d` | +197/-57 | feat(billing): add admin gift subscription system with Strip |
| 2025-12-12 | `8c3bb500` | +16/-16 | feat(gift-subs): Use single-use coupons and fix lint errors |
| 2025-12-12 | `dd7aa44f` | +2/-2 | fix(billing): use POST instead of PUT for gift subscription  |

## Size Evolution

```
2025-08-21: ████████████████████████████ 285 lines
2025-09-17: ███████████████████████████████████ 356 lines
2025-09-17: ██████████████████████████████████████ 387 lines
2025-09-21: ████████████████████████████████████████ 408 lines
2025-09-21: ████████████████████████████████████████ 408 lines
2025-09-24: █████████████████████████████████████████ 410 lines
2025-10-08: ███████████████████████████████████████ 399 lines
2025-11-28: ███████████████████████████████████████ 399 lines
2025-12-12: ██████████████████████████████████████████████████ 539 lines
2025-12-12: ██████████████████████████████████████████████████ 539 lines
2025-12-12: ██████████████████████████████████████████████████ 539 lines
```

## Notable Patterns

### Large Changes

- **2025-08-21** (`36a0d18f`): +285/-0
  - "Open Beta Init"
- **2025-12-12** (`2ffaf60d`): +197/-57
  - "feat(billing): add admin gift subscription system with Stripe integration"

## Verification Commands

```bash
# View full file history
git log --follow --stat -- "apps/web/src/components/admin/UsersTable.tsx"

# View specific commit diff
git show <commit-hash> -- "apps/web/src/components/admin/UsersTable.tsx"
```