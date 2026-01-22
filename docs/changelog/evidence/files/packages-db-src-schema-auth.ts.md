# File Evolution: packages/db/src/schema/auth.ts

> Generated: 2026-01-22T14:52:00.559Z

## Summary

- **Total Commits**: 21
- **Lines Added**: 234
- **Lines Deleted**: 21
- **Net Change**: 213 lines

## Lifecycle Status

**✅ ACTIVE** - This file exists in the current codebase.

## Commit History

| Date | Commit | +/- | Message |
|------|--------|-----|---------|
| 2025-08-21 | `36a0d18f` | +74/-0 | Open Beta Init |
| 2025-09-13 | `55f83d30` | +7/-1 | Everything works with size limts except pdf. |
| 2025-09-17 | `a83c56e5` | +9/-1 | stripe payment |
| 2025-09-17 | `5bfaa1bb` | +1/-3 | billing, storage, rate limits all done now |
| 2025-09-21 | `d09a65c7` | +1/-1 | billing upgrade |
| 2025-09-21 | `243d04f4` | +1/-1 | Correct cloud subscription model |
| 2025-09-22 | `6c705e9e` | +1/-1 | GLM as default model |
| 2025-10-03 | `b7275501` | +24/-0 | resend email |
| 2025-10-13 | `b998ed76` | +1/-1 | fix glm model name fix |
| 2025-10-20 | `35797bae` | +1/-2 | fixed rate limiting |
| 2025-11-01 | `f4b3e3ae` | +1/-0 | Add TOS/Privacy agreement checkbox to signup and notificatio |
| 2025-11-14 | `a24be4b2` | +49/-0 | Add device token foundation (Phase 1) - validating simpler a |
| 2025-11-16 | `f7462ac7` | +1/-1 | build errors |
| 2025-11-17 | `7fd38842` | +8/-2 | UI for saved devices |
| 2025-11-17 | `7c795147` | +2/-2 | P1 Badge Expired device tokens still block new ones |
| 2025-11-17 | `8eef78da` | +3/-3 | fixed index |
| 2025-12-12 | `6911bfc3` | +1/-1 | Commit all changes |
| 2026-01-08 | `da3b156d` | +10/-0 | feat(security): P1 Security Foundation - JTI, Rate Limiting, |
| 2026-01-10 | `17c021db` | +12/-1 | feat(security): P1 Security Foundation - Complete Implementa |
| 2026-01-10 | `fcf4d31d` | +25/-0 | feat(auth): add socket token endpoint for cross-origin Socke |
| 2026-01-12 | `0125609e` | +2/-0 | feat(security): Phase 2 session management foundation (#184) |

## Size Evolution

```
2025-08-21: ███████ 74 lines
2025-09-13: ████████ 80 lines
2025-09-17: ████████ 88 lines
2025-09-17: ████████ 86 lines
2025-09-21: ████████ 86 lines
2025-09-21: ████████ 86 lines
2025-09-22: ████████ 86 lines
2025-10-03: ███████████ 110 lines
2025-10-13: ███████████ 110 lines
2025-10-20: ██████████ 109 lines
2025-11-01: ███████████ 110 lines
2025-11-14: ███████████████ 159 lines
2025-11-16: ███████████████ 159 lines
2025-11-17: ████████████████ 165 lines
2025-11-17: ████████████████ 165 lines
2025-11-17: ████████████████ 165 lines
2025-12-12: ████████████████ 165 lines
2026-01-08: █████████████████ 175 lines
2026-01-10: ██████████████████ 186 lines
2026-01-10: █████████████████████ 211 lines
2026-01-12: █████████████████████ 213 lines
```

## Notable Patterns

## Verification Commands

```bash
# View full file history
git log --follow --stat -- "packages/db/src/schema/auth.ts"

# View specific commit diff
git show <commit-hash> -- "packages/db/src/schema/auth.ts"
```