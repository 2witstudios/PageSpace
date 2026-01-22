# File Evolution: apps/desktop/src/main/index.ts

> Generated: 2026-01-22T14:52:00.128Z

## Summary

- **Total Commits**: 31
- **Lines Added**: 1354
- **Lines Deleted**: 312
- **Net Change**: 1042 lines

## Lifecycle Status

**✅ ACTIVE** - This file exists in the current codebase.

## Commit History

| Date | Commit | +/- | Message |
|------|--------|-----|---------|
| 2025-10-07 | `514904d2` | +325/-0 | electron |
| 2025-10-16 | `94e5acfa` | +2/-2 | electron updated icons and signed |
| 2025-10-16 | `11ea6c1b` | +8/-1 | electron works |
| 2025-10-16 | `5ca94e93` | +40/-0 | drag window |
| 2025-10-16 | `cf7f3f4a` | +3/-2 | adding windows support |
| 2025-10-16 | `066d5dc6` | +2/-2 | fixed url |
| 2025-10-16 | `2ae50f01` | +6/-1 | added some debounce length, fixed prettier deleting spaces,  |
| 2025-10-17 | `60296bd0` | +104/-7 | GH actions update for electron updates |
| 2025-10-18 | `a8e563f8` | +5/-5 | Update index.ts |
| 2025-10-18 | `58b6c8a9` | +29/-0 | offline screen |
| 2025-10-18 | `5c4e0942` | +1/-1 | Update index.ts |
| 2025-10-18 | `ff5d6157` | +3/-2 | fixed offline |
| 2025-10-18 | `f570befe` | +3/-1 | auto update wasnt working |
| 2025-10-20 | `ca2b79c4` | +0/-6 | updated build for proper electron pre script |
| 2025-10-27 | `f46d169a` | +124/-2 | phase 1 |
| 2025-10-27 | `454f3ce5` | +51/-16 | phase 2 |
| 2025-10-28 | `847c3500` | +15/-3 | finally working but needs polish. but zod saving config |
| 2025-10-29 | `b684fac5` | +44/-1 | bearers |
| 2025-10-29 | `497a8ea0` | +18/-4 | working mcp with proper header validation |
| 2025-10-29 | `9e256b7a` | +16/-15 | structured logging in desktop |
| 2025-11-14 | `a0b0044a` | +116/-23 | Avoid null desktop device token |
| 2025-11-14 | `af9e7816` | +116/-23 | Avoid null desktop device token |
| 2025-11-14 | `d1828172` | +116/-23 | web: clear desktop auth on expiry |
| 2025-11-18 | `f9318060` | +2/-1 | device list view + esm import for node in desktop |
| 2025-11-22 | `6db25739` | +29/-1 | Authentication Flow Overhaul - Complete |
| 2025-12-28 | `f56b2d31` | +1/-1 | chore: add typecheck scripts and fix type errors across mono |
| 2026-01-11 | `8bd930e2` | +2/-2 | feat(desktop): reduce default window size to 1100x700 (#180) |
| 2026-01-12 | `79ad37dc` | +65/-13 | fix(desktop): Fix macOS session persistence with safeStorage |
| 2026-01-14 | `54999113` | +96/-1 | fix(desktop): add power state handling to prevent premature  |
| 2026-01-14 | `d82f1a72` | +4/-153 | fix(desktop): use secure storage for WSClient JWT auth (#209 |
| 2026-01-15 | `a1bc9df0` | +8/-0 | fix(mcp): add toolsReady flag to prevent empty tools on firs |

## Size Evolution

```
2025-10-07: ████████████████████████████████ 325 lines
2025-10-16: ████████████████████████████████ 325 lines
2025-10-16: █████████████████████████████████ 332 lines
2025-10-16: █████████████████████████████████████ 372 lines
2025-10-16: █████████████████████████████████████ 373 lines
2025-10-16: █████████████████████████████████████ 373 lines
2025-10-16: █████████████████████████████████████ 378 lines
2025-10-17: ███████████████████████████████████████████████ 475 lines
2025-10-18: ███████████████████████████████████████████████ 475 lines
2025-10-18: ██████████████████████████████████████████████████ 504 lines
2025-10-18: ██████████████████████████████████████████████████ 504 lines
2025-10-18: ██████████████████████████████████████████████████ 505 lines
2025-10-18: ██████████████████████████████████████████████████ 507 lines
2025-10-20: ██████████████████████████████████████████████████ 501 lines
2025-10-27: ██████████████████████████████████████████████████ 623 lines
2025-10-27: ██████████████████████████████████████████████████ 658 lines
2025-10-28: ██████████████████████████████████████████████████ 670 lines
2025-10-29: ██████████████████████████████████████████████████ 713 lines
2025-10-29: ██████████████████████████████████████████████████ 727 lines
2025-10-29: ██████████████████████████████████████████████████ 728 lines
2025-11-14: ██████████████████████████████████████████████████ 821 lines
2025-11-14: ██████████████████████████████████████████████████ 914 lines
2025-11-14: ██████████████████████████████████████████████████ 1007 lines
2025-11-18: ██████████████████████████████████████████████████ 1008 lines
2025-11-22: ██████████████████████████████████████████████████ 1036 lines
2025-12-28: ██████████████████████████████████████████████████ 1036 lines
2026-01-11: ██████████████████████████████████████████████████ 1036 lines
2026-01-12: ██████████████████████████████████████████████████ 1088 lines
2026-01-14: ██████████████████████████████████████████████████ 1183 lines
2026-01-14: ██████████████████████████████████████████████████ 1034 lines
2026-01-15: ██████████████████████████████████████████████████ 1042 lines
```

## Notable Patterns

### Large Changes

- **2025-10-07** (`514904d2`): +325/-0
  - "electron"
- **2025-10-17** (`60296bd0`): +104/-7
  - "GH actions update for electron updates"
- **2025-10-27** (`f46d169a`): +124/-2
  - "phase 1"
- **2025-11-14** (`a0b0044a`): +116/-23
  - "Avoid null desktop device token"
- **2025-11-14** (`af9e7816`): +116/-23
  - "Avoid null desktop device token"
- **2025-11-14** (`d1828172`): +116/-23
  - "web: clear desktop auth on expiry"
- **2026-01-14** (`d82f1a72`): +4/-153
  - "fix(desktop): use secure storage for WSClient JWT auth (#209)"

### Candid Developer Notes

- **2025-10-28**: "finally working but needs polish. but zod saving config"

## Verification Commands

```bash
# View full file history
git log --follow --stat -- "apps/desktop/src/main/index.ts"

# View specific commit diff
git show <commit-hash> -- "apps/desktop/src/main/index.ts"
```