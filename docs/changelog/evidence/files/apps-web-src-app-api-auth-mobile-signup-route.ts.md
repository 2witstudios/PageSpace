# File Evolution: apps/web/src/app/api/auth/mobile/signup/route.ts

> Generated: 2026-01-22T14:52:04.507Z

## Summary

- **Total Commits**: 25
- **Lines Added**: 521
- **Lines Deleted**: 147
- **Net Change**: 374 lines

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
| 2025-11-01 | `de77f983` | +30/-46 | compiles/auth |
| 2025-11-02 | `e1922b10` | +9/-2 | CSRF fix |
| 2025-11-02 | `486a16b6` | +1/-1 | auth mismatch fixed |
| 2025-11-14 | `a0b0044a` | +52/-4 | Avoid null desktop device token |
| 2025-11-14 | `af9e7816` | +52/-4 | Avoid null desktop device token |
| 2025-11-14 | `d1828172` | +52/-4 | web: clear desktop auth on expiry |
| 2025-11-16 | `f7462ac7` | +9/-11 | build errors |
| 2025-11-23 | `d5e00db6` | +4/-26 | ios no longer sessoin based |
| 2025-12-14 | `e61eaa16` | +8/-3 | [web] Default new drive to Getting Started |
| 2025-12-14 | `082bab9f` | +1/-1 | [web] Fix signup Zod error messages |
| 2025-12-14 | `b5557118` | +9/-1 | [web] Make drive seeding best-effort |
| 2026-01-08 | `da3b156d` | +28/-19 | feat(security): P1 Security Foundation - JTI, Rate Limiting, |

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
2025-11-01: ██████████████████████ 225 lines
2025-11-02: ███████████████████████ 232 lines
2025-11-02: ███████████████████████ 232 lines
2025-11-14: ████████████████████████████ 280 lines
2025-11-14: ████████████████████████████████ 328 lines
2025-11-14: █████████████████████████████████████ 376 lines
2025-11-16: █████████████████████████████████████ 374 lines
2025-11-23: ███████████████████████████████████ 352 lines
2025-12-14: ███████████████████████████████████ 357 lines
2025-12-14: ███████████████████████████████████ 357 lines
2025-12-14: ████████████████████████████████████ 365 lines
2026-01-08: █████████████████████████████████████ 374 lines
```

## Notable Patterns

### Large Changes

- **2025-08-21** (`36a0d18f`): +135/-0
  - "Open Beta Init"

## Verification Commands

```bash
# View full file history
git log --follow --stat -- "apps/web/src/app/api/auth/mobile/signup/route.ts"

# View specific commit diff
git show <commit-hash> -- "apps/web/src/app/api/auth/mobile/signup/route.ts"
```