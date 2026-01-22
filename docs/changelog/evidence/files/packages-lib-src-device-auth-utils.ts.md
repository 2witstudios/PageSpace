# File Evolution: packages/lib/src/device-auth-utils.ts

> Generated: 2026-01-22T14:52:04.821Z

## Summary

- **Total Commits**: 12
- **Lines Added**: 577
- **Lines Deleted**: 575
- **Net Change**: 2 lines

## Lifecycle Status

**✅ ACTIVE** - This file exists in the current codebase.

## Commit History

| Date | Commit | +/- | Message |
|------|--------|-----|---------|
| 2025-11-14 | `a24be4b2` | +320/-0 | Add device token foundation (Phase 1) - validating simpler a |
| 2025-11-14 | `a0b0044a` | +3/-2 | Avoid null desktop device token |
| 2025-11-14 | `af9e7816` | +3/-2 | Avoid null desktop device token |
| 2025-11-14 | `d1828172` | +3/-2 | web: clear desktop auth on expiry |
| 2025-11-16 | `f7462ac7` | +85/-5 | build errors |
| 2025-11-16 | `771522ad` | +20/-1 | tokenVersion revocations |
| 2025-11-17 | `62abfa9e` | +44/-15 | Check if an active device token already exists for this user |
| 2025-11-17 | `877ff7c5` | +2/-1 | Avoid reusing expired device tokens |
| 2025-11-17 | `8eef78da` | +50/-0 | fixed index |
| 2025-11-17 | `53352385` | +1/-1 | added sql import |
| 2025-11-18 | `d36dced1` | +46/-1 | revoking works and multiple desktops work |
| 2025-11-28 | `005f17a6` | +0/-545 | refactor: reorganize packages/lib and apps/web/src/lib into  |

## Size Evolution

```
2025-11-14: ████████████████████████████████ 320 lines
2025-11-14: ████████████████████████████████ 321 lines
2025-11-14: ████████████████████████████████ 322 lines
2025-11-14: ████████████████████████████████ 323 lines
2025-11-16: ████████████████████████████████████████ 403 lines
2025-11-16: ██████████████████████████████████████████ 422 lines
2025-11-17: █████████████████████████████████████████████ 451 lines
2025-11-17: █████████████████████████████████████████████ 452 lines
2025-11-17: ██████████████████████████████████████████████████ 502 lines
2025-11-17: ██████████████████████████████████████████████████ 502 lines
2025-11-18: ██████████████████████████████████████████████████ 547 lines
2025-11-28:  2 lines
```

## Notable Patterns

### Large Changes

- **2025-11-14** (`a24be4b2`): +320/-0
  - "Add device token foundation (Phase 1) - validating simpler approach first"
- **2025-11-28** (`005f17a6`): +0/-545
  - "refactor: reorganize packages/lib and apps/web/src/lib into semantic directories"

## Verification Commands

```bash
# View full file history
git log --follow --stat -- "packages/lib/src/device-auth-utils.ts"

# View specific commit diff
git show <commit-hash> -- "packages/lib/src/device-auth-utils.ts"
```