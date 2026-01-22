# File Evolution: apps/web/src/app/api/auth/google/callback/route.ts

> Generated: 2026-01-22T14:52:01.355Z

## Summary

- **Total Commits**: 19
- **Lines Added**: 525
- **Lines Deleted**: 74
- **Net Change**: 451 lines

## Lifecycle Status

**✅ ACTIVE** - This file exists in the current codebase.

## Commit History

| Date | Commit | +/- | Message |
|------|--------|-----|---------|
| 2025-08-21 | `36a0d18f` | +227/-0 | Open Beta Init |
| 2025-09-17 | `a83c56e5` | +5/-0 | stripe payment |
| 2025-09-17 | `5bfaa1bb` | +1/-3 | billing, storage, rate limits all done now |
| 2025-09-21 | `243d04f4` | +1/-1 | Correct cloud subscription model |
| 2025-09-25 | `17b31d56` | +1/-1 | Major refactor of logger routes to use server |
| 2025-11-14 | `c3d772ff` | +2/-2 | Implement configurable refresh token TTL (simple solution fo |
| 2025-11-14 | `a0b0044a` | +10/-1 | Avoid null desktop device token |
| 2025-11-14 | `af9e7816` | +10/-1 | Avoid null desktop device token |
| 2025-11-14 | `d1828172` | +10/-1 | web: clear desktop auth on expiry |
| 2025-11-18 | `216e9710` | +100/-10 | fixed connected device route |
| 2025-11-18 | `3690ad40` | +1/-1 | revoke without pass |
| 2025-11-18 | `58fe49cf` | +13/-1 | fixed socket connections and desktop connections to web app  |
| 2025-12-14 | `e61eaa16` | +9/-4 | [web] Default new drive to Getting Started |
| 2025-12-14 | `b5557118` | +9/-1 | [web] Make drive seeding best-effort |
| 2025-12-15 | `653774dc` | +18/-31 | [web] Centralize Getting Started drive provisioning |
| 2025-12-15 | `b0f37fe2` | +5/-5 | [web] Address PR review feedback for auth tests |
| 2026-01-08 | `da3b156d` | +20/-8 | feat(security): P1 Security Foundation - JTI, Rate Limiting, |
| 2026-01-10 | `17c021db` | +6/-2 | feat(security): P1 Security Foundation - Complete Implementa |
| 2026-01-21 | `fe28868e` | +77/-1 | fix(auth): device persistence improvements and auth loop pre |

## Size Evolution

```
2025-08-21: ██████████████████████ 227 lines
2025-09-17: ███████████████████████ 232 lines
2025-09-17: ███████████████████████ 230 lines
2025-09-21: ███████████████████████ 230 lines
2025-09-25: ███████████████████████ 230 lines
2025-11-14: ███████████████████████ 230 lines
2025-11-14: ███████████████████████ 239 lines
2025-11-14: ████████████████████████ 248 lines
2025-11-14: █████████████████████████ 257 lines
2025-11-18: ██████████████████████████████████ 347 lines
2025-11-18: ██████████████████████████████████ 347 lines
2025-11-18: ███████████████████████████████████ 359 lines
2025-12-14: ████████████████████████████████████ 364 lines
2025-12-14: █████████████████████████████████████ 372 lines
2025-12-15: ███████████████████████████████████ 359 lines
2025-12-15: ███████████████████████████████████ 359 lines
2026-01-08: █████████████████████████████████████ 371 lines
2026-01-10: █████████████████████████████████████ 375 lines
2026-01-21: █████████████████████████████████████████████ 451 lines
```

## Notable Patterns

### Large Changes

- **2025-08-21** (`36a0d18f`): +227/-0
  - "Open Beta Init"

## Verification Commands

```bash
# View full file history
git log --follow --stat -- "apps/web/src/app/api/auth/google/callback/route.ts"

# View specific commit diff
git show <commit-hash> -- "apps/web/src/app/api/auth/google/callback/route.ts"
```