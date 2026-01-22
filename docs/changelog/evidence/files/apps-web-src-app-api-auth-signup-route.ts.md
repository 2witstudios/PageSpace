# File Evolution: apps/web/src/app/api/auth/signup/route.ts

> Generated: 2026-01-22T14:52:00.288Z

## Summary

- **Total Commits**: 27
- **Lines Added**: 467
- **Lines Deleted**: 94
- **Net Change**: 373 lines

## Lifecycle Status

**✅ ACTIVE** - This file exists in the current codebase.

## Commit History

| Date | Commit | +/- | Message |
|------|--------|-----|---------|
| 2025-08-21 | `36a0d18f` | +135/-0 | Open Beta Init |
| 2025-09-17 | `a83c56e5` | +5/-0 | stripe payment |
| 2025-09-17 | `5bfaa1bb` | +1/-3 | billing, storage, rate limits all done now |
| 2025-09-19 | `a8aac666` | +2/-1 | Ollama support, batch fixes |
| 2025-09-21 | `243d04f4` | +1/-1 | Correct cloud subscription model |
| 2025-09-25 | `17b31d56` | +1/-1 | Major refactor of logger routes to use server |
| 2025-09-29 | `a8243ccf` | +7/-4 | auth/password prot |
| 2025-09-30 | `42e4d3da` | +42/-2 | ecurity patch |
| 2025-10-03 | `b7275501` | +26/-0 | resend email |
| 2025-10-04 | `d4d0f794` | +13/-1 | email verification |
| 2025-10-06 | `edad0646` | +5/-2 | password fix |
| 2025-10-06 | `adf4279b` | +24/-10 | fixed login stuff |
| 2025-11-01 | `f4b3e3ae` | +4/-0 | Add TOS/Privacy agreement checkbox to signup and notificatio |
| 2025-11-14 | `c3d772ff` | +2/-2 | Implement configurable refresh token TTL (simple solution fo |
| 2025-11-14 | `a0b0044a` | +10/-1 | Avoid null desktop device token |
| 2025-11-14 | `af9e7816` | +10/-1 | Avoid null desktop device token |
| 2025-11-14 | `d1828172` | +10/-1 | web: clear desktop auth on expiry |
| 2025-11-17 | `7fd38842` | +28/-3 | UI for saved devices |
| 2025-11-17 | `bf08458b` | +4/-1 | P1 Badge Link web refresh tokens to device tokens |
| 2025-12-14 | `c4131e01` | +14/-8 | [web] Seed new drive during signup |
| 2025-12-14 | `e61eaa16` | +2/-2 | [web] Default new drive to Getting Started |
| 2025-12-14 | `082bab9f` | +1/-1 | [web] Fix signup Zod error messages |
| 2025-12-14 | `b5557118` | +8/-1 | [web] Make drive seeding best-effort |
| 2025-12-15 | `653774dc` | +14/-24 | [web] Centralize Getting Started drive provisioning |
| 2025-12-21 | `39959f20` | +53/-3 | docs: Add CSRF security audit report (#108) |
| 2026-01-08 | `da3b156d` | +39/-19 | feat(security): P1 Security Foundation - JTI, Rate Limiting, |
| 2026-01-10 | `17c021db` | +6/-2 | feat(security): P1 Security Foundation - Complete Implementa |

## Size Evolution

```
2025-08-21: █████████████ 135 lines
2025-09-17: ██████████████ 140 lines
2025-09-17: █████████████ 138 lines
2025-09-19: █████████████ 139 lines
2025-09-21: █████████████ 139 lines
2025-09-25: █████████████ 139 lines
2025-09-29: ██████████████ 142 lines
2025-09-30: ██████████████████ 182 lines
2025-10-03: ████████████████████ 208 lines
2025-10-04: ██████████████████████ 220 lines
2025-10-06: ██████████████████████ 223 lines
2025-10-06: ███████████████████████ 237 lines
2025-11-01: ████████████████████████ 241 lines
2025-11-14: ████████████████████████ 241 lines
2025-11-14: █████████████████████████ 250 lines
2025-11-14: █████████████████████████ 259 lines
2025-11-14: ██████████████████████████ 268 lines
2025-11-17: █████████████████████████████ 293 lines
2025-11-17: █████████████████████████████ 296 lines
2025-12-14: ██████████████████████████████ 302 lines
2025-12-14: ██████████████████████████████ 302 lines
2025-12-14: ██████████████████████████████ 302 lines
2025-12-14: ██████████████████████████████ 309 lines
2025-12-15: █████████████████████████████ 299 lines
2025-12-21: ██████████████████████████████████ 349 lines
2026-01-08: ████████████████████████████████████ 369 lines
2026-01-10: █████████████████████████████████████ 373 lines
```

## Notable Patterns

### Large Changes

- **2025-08-21** (`36a0d18f`): +135/-0
  - "Open Beta Init"

## Verification Commands

```bash
# View full file history
git log --follow --stat -- "apps/web/src/app/api/auth/signup/route.ts"

# View specific commit diff
git show <commit-hash> -- "apps/web/src/app/api/auth/signup/route.ts"
```