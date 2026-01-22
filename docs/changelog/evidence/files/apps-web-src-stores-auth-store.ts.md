# File Evolution: apps/web/src/stores/auth-store.ts

> Generated: 2026-01-22T14:52:01.715Z

## Summary

- **Total Commits**: 18
- **Lines Added**: 667
- **Lines Deleted**: 645
- **Net Change**: 22 lines

## Lifecycle Status

**✅ ACTIVE** - This file exists in the current codebase.

## Commit History

| Date | Commit | +/- | Message |
|------|--------|-----|---------|
| 2025-08-21 | `36a0d18f` | +241/-0 | Open Beta Init |
| 2025-09-15 | `1921f9fc` | +1/-0 | avatars |
| 2025-09-23 | `2446bf5d` | +166/-9 | better auth checks |
| 2025-09-30 | `fee8c442` | +1/-0 | Update auth-store.ts |
| 2025-10-03 | `d8e8ed26` | +5/-2 | fixed login loading state for 0auth |
| 2025-10-04 | `d4d0f794` | +2/-0 | email verification |
| 2025-10-08 | `0f828e3b` | +17/-2 | CSRF |
| 2025-10-13 | `b896adda` | +27/-3 | Much better state that isnt lost moving around with global a |
| 2025-10-14 | `4b0f0ca9` | +35/-14 | fixed some state issues with flashes |
| 2025-10-14 | `de9120f4` | +17/-2 | state updates |
| 2025-11-14 | `a0b0044a` | +11/-0 | Avoid null desktop device token |
| 2025-11-14 | `af9e7816` | +11/-0 | Avoid null desktop device token |
| 2025-11-14 | `d1828172` | +27/-0 | web: clear desktop auth on expiry |
| 2025-11-20 | `87ea87e7` | +29/-16 | fixed routes that had old auth that wouldnt work for desktop |
| 2025-11-22 | `6db25739` | +72/-7 | Authentication Flow Overhaul - Complete |
| 2025-11-25 | `cd3150e6` | +1/-0 | admin prompt viewer |
| 2025-11-28 | `005f17a6` | +4/-4 | refactor: reorganize packages/lib and apps/web/src/lib into  |
| 2025-12-22 | `0e53895b` | +0/-586 | Fix inconsistent code patterns for easier onboarding (#117) |

## Size Evolution

```
2025-08-21: ████████████████████████ 241 lines
2025-09-15: ████████████████████████ 242 lines
2025-09-23: ███████████████████████████████████████ 399 lines
2025-09-30: ████████████████████████████████████████ 400 lines
2025-10-03: ████████████████████████████████████████ 403 lines
2025-10-04: ████████████████████████████████████████ 405 lines
2025-10-08: ██████████████████████████████████████████ 420 lines
2025-10-13: ████████████████████████████████████████████ 444 lines
2025-10-14: ██████████████████████████████████████████████ 465 lines
2025-10-14: ████████████████████████████████████████████████ 480 lines
2025-11-14: █████████████████████████████████████████████████ 491 lines
2025-11-14: ██████████████████████████████████████████████████ 502 lines
2025-11-14: ██████████████████████████████████████████████████ 529 lines
2025-11-20: ██████████████████████████████████████████████████ 542 lines
2025-11-22: ██████████████████████████████████████████████████ 607 lines
2025-11-25: ██████████████████████████████████████████████████ 608 lines
2025-11-28: ██████████████████████████████████████████████████ 608 lines
2025-12-22: ██ 22 lines
```

## Notable Patterns

### Large Changes

- **2025-08-21** (`36a0d18f`): +241/-0
  - "Open Beta Init"
- **2025-09-23** (`2446bf5d`): +166/-9
  - "better auth checks"
- **2025-12-22** (`0e53895b`): +0/-586
  - "Fix inconsistent code patterns for easier onboarding (#117)"

## Verification Commands

```bash
# View full file history
git log --follow --stat -- "apps/web/src/stores/auth-store.ts"

# View specific commit diff
git show <commit-hash> -- "apps/web/src/stores/auth-store.ts"
```