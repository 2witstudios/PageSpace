# File Evolution: apps/web/src/app/api/upload/route.ts

> Generated: 2026-01-22T14:52:01.202Z

## Summary

- **Total Commits**: 19
- **Lines Added**: 806
- **Lines Deleted**: 306
- **Net Change**: 500 lines

## Lifecycle Status

**✅ ACTIVE** - This file exists in the current codebase.

## Commit History

| Date | Commit | +/- | Message |
|------|--------|-----|---------|
| 2025-09-10 | `9e7122a4` | +127/-0 | Upload works for now |
| 2025-09-11 | `ce63e21b` | +70/-7 | uploading documents done with proper drag and drop |
| 2025-09-12 | `69b899a8` | +10/-6 | fixed pic upload with special charectors |
| 2025-09-12 | `0a7abc73` | +45/-9 | text extraction for docx/pdf for uploaded files |
| 2025-09-13 | `d90f97ee` | +182/-131 | upload service/image processing |
| 2025-09-13 | `55f83d30` | +107/-11 | Everything works with size limts except pdf. |
| 2025-09-13 | `8906480c` | +10/-10 | Non PDF pics work, but its not being labeled as visual if th |
| 2025-09-25 | `8c2b9d60` | +30/-10 | Fix drive membership checks in permissions |
| 2025-09-25 | `1bb7ec90` | +2/-2 | better drive check |
| 2025-09-26 | `42c26769` | +11/-0 | tenant token |
| 2025-09-28 | `56424cf5` | +1/-0 | fixed driveId issue |
| 2025-09-28 | `4797e9c9` | +78/-22 | working auth just need to test |
| 2025-09-29 | `5372494d` | +36/-12 | auth drive fix |
| 2025-09-29 | `9f525f0d` | +0/-4 | allows same file across drives |
| 2025-09-30 | `42e4d3da` | +4/-6 | ecurity patch |
| 2025-10-08 | `0f828e3b` | +27/-25 | CSRF |
| 2025-12-22 | `a3586f4e` | +12/-0 | feat(monitoring): extend activity logging for enterprise com |
| 2026-01-10 | `17c021db` | +23/-12 | feat(security): P1 Security Foundation - Complete Implementa |
| 2026-01-11 | `c4fcaec3` | +31/-39 | security(P1-T4): Complete upload route token validation - Ph |

## Size Evolution

```
2025-09-10: ████████████ 127 lines
2025-09-11: ███████████████████ 190 lines
2025-09-12: ███████████████████ 194 lines
2025-09-12: ███████████████████████ 230 lines
2025-09-13: ████████████████████████████ 281 lines
2025-09-13: █████████████████████████████████████ 377 lines
2025-09-13: █████████████████████████████████████ 377 lines
2025-09-25: ███████████████████████████████████████ 397 lines
2025-09-25: ███████████████████████████████████████ 397 lines
2025-09-26: ████████████████████████████████████████ 408 lines
2025-09-28: ████████████████████████████████████████ 409 lines
2025-09-28: ██████████████████████████████████████████████ 465 lines
2025-09-29: ████████████████████████████████████████████████ 489 lines
2025-09-29: ████████████████████████████████████████████████ 485 lines
2025-09-30: ████████████████████████████████████████████████ 483 lines
2025-10-08: ████████████████████████████████████████████████ 485 lines
2025-12-22: █████████████████████████████████████████████████ 497 lines
2026-01-10: ██████████████████████████████████████████████████ 508 lines
2026-01-11: ██████████████████████████████████████████████████ 500 lines
```

## Notable Patterns

### Large Changes

- **2025-09-10** (`9e7122a4`): +127/-0
  - "Upload works for now"
- **2025-09-13** (`d90f97ee`): +182/-131
  - "upload service/image processing"
- **2025-09-13** (`55f83d30`): +107/-11
  - "Everything works with size limts except pdf."

## Verification Commands

```bash
# View full file history
git log --follow --stat -- "apps/web/src/app/api/upload/route.ts"

# View specific commit diff
git show <commit-hash> -- "apps/web/src/app/api/upload/route.ts"
```