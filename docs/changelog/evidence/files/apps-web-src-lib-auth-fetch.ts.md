# File Evolution: apps/web/src/lib/auth-fetch.ts

> Generated: 2026-01-22T14:52:01.786Z

## Summary

- **Total Commits**: 18
- **Lines Added**: 1064
- **Lines Deleted**: 838
- **Net Change**: 226 lines

## Lifecycle Status

**✅ ACTIVE** - This file exists in the current codebase.

## Commit History

| Date | Commit | +/- | Message |
|------|--------|-----|---------|
| 2025-08-21 | `36a0d18f` | +215/-0 | Open Beta Init |
| 2025-09-23 | `be30092f` | +23/-8 | Improve structured logging across usage flows |
| 2025-10-08 | `0f828e3b` | +149/-2 | CSRF |
| 2025-10-08 | `39cb880b` | +4/-4 | authfetch |
| 2025-10-14 | `de9120f4` | +21/-4 | state updates |
| 2025-10-29 | `b684fac5` | +81/-21 | bearers |
| 2025-10-29 | `97342f9e` | +28/-4 | fixed auth refresh for desktop |
| 2025-11-14 | `a0b0044a` | +118/-10 | Avoid null desktop device token |
| 2025-11-14 | `af9e7816` | +118/-10 | Avoid null desktop device token |
| 2025-11-14 | `263146a0` | +17/-7 | Avoid null device token in desktop refresh |
| 2025-11-14 | `d1828172` | +118/-10 | web: clear desktop auth on expiry |
| 2025-11-17 | `7fd38842` | +19/-1 | UI for saved devices |
| 2025-11-17 | `ed47c2e9` | +50/-6 | Revoke All Other Devices |
| 2025-11-18 | `216e9710` | +16/-1 | fixed connected device route |
| 2025-11-20 | `87ea87e7` | +29/-16 | fixed routes that had old auth that wouldnt work for desktop |
| 2025-11-22 | `6db25739` | +56/-14 | Authentication Flow Overhaul - Complete |
| 2025-11-23 | `86262a80` | +2/-2 | jose dependency and null check for storage |
| 2025-11-28 | `005f17a6` | +0/-718 | refactor: reorganize packages/lib and apps/web/src/lib into  |

## Size Evolution

```
2025-08-21: █████████████████████ 215 lines
2025-09-23: ███████████████████████ 230 lines
2025-10-08: █████████████████████████████████████ 377 lines
2025-10-08: █████████████████████████████████████ 377 lines
2025-10-14: ███████████████████████████████████████ 394 lines
2025-10-29: █████████████████████████████████████████████ 454 lines
2025-10-29: ███████████████████████████████████████████████ 478 lines
2025-11-14: ██████████████████████████████████████████████████ 586 lines
2025-11-14: ██████████████████████████████████████████████████ 694 lines
2025-11-14: ██████████████████████████████████████████████████ 704 lines
2025-11-14: ██████████████████████████████████████████████████ 812 lines
2025-11-17: ██████████████████████████████████████████████████ 830 lines
2025-11-17: ██████████████████████████████████████████████████ 874 lines
2025-11-18: ██████████████████████████████████████████████████ 889 lines
2025-11-20: ██████████████████████████████████████████████████ 902 lines
2025-11-22: ██████████████████████████████████████████████████ 944 lines
2025-11-23: ██████████████████████████████████████████████████ 944 lines
2025-11-28: ██████████████████████ 226 lines
```

## Notable Patterns

### Large Changes

- **2025-08-21** (`36a0d18f`): +215/-0
  - "Open Beta Init"
- **2025-10-08** (`0f828e3b`): +149/-2
  - "CSRF"
- **2025-11-14** (`a0b0044a`): +118/-10
  - "Avoid null desktop device token"
- **2025-11-14** (`af9e7816`): +118/-10
  - "Avoid null desktop device token"
- **2025-11-14** (`d1828172`): +118/-10
  - "web: clear desktop auth on expiry"
- **2025-11-28** (`005f17a6`): +0/-718
  - "refactor: reorganize packages/lib and apps/web/src/lib into semantic directories"

## Verification Commands

```bash
# View full file history
git log --follow --stat -- "apps/web/src/lib/auth-fetch.ts"

# View specific commit diff
git show <commit-hash> -- "apps/web/src/lib/auth-fetch.ts"
```