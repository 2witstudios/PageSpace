# File Evolution: apps/web/src/app/api/ai/settings/route.ts

> Generated: 2026-01-22T14:52:01.645Z

## Summary

- **Total Commits**: 18
- **Lines Added**: 476
- **Lines Deleted**: 93
- **Net Change**: 383 lines

## Lifecycle Status

**✅ ACTIVE** - This file exists in the current codebase.

## Commit History

| Date | Commit | +/- | Message |
|------|--------|-----|---------|
| 2025-08-21 | `36a0d18f` | +283/-0 | Open Beta Init |
| 2025-09-19 | `a8aac666` | +46/-20 | Ollama support, batch fixes |
| 2025-09-21 | `8bbfbfe7` | +13/-9 | MCP Updated and consolidated |
| 2025-09-22 | `5eca9459` | +24/-9 | GLM working |
| 2025-09-22 | `6c705e9e` | +24/-1 | GLM as default model |
| 2025-09-22 | `4d07ee4d` | +1/-1 | New pricing |
| 2025-09-23 | `119cbc29` | +1/-1 | fixed copy |
| 2025-09-25 | `17b31d56` | +1/-1 | Major refactor of logger routes to use server |
| 2025-10-08 | `0f828e3b` | +11/-9 | CSRF |
| 2025-10-13 | `b998ed76` | +1/-1 | fix glm model name fix |
| 2025-10-20 | `f5b120dc` | +24/-9 | working response |
| 2025-11-28 | `f5e41faf` | +1/-1 | refactor: reorganize AI codebase for semantic clarity (WIP) |
| 2025-12-02 | `794762b7` | +24/-9 | feat(ai): add MiniMax M2 as BYO provider |
| 2025-12-12 | `ba7ad82c` | +6/-5 | fix(api): align CSRF config with HTTP semantics for GET endp |
| 2025-12-13 | `2c0f27e5` | +1/-1 | refactor: migrate imports to use barrel files |
| 2025-12-14 | `544e81f4` | +7/-13 | refactor: add aiSettingsRepository seam and fix CodeRabbit f |
| 2025-12-15 | `fb957146` | +1/-1 | fix: type error in settings route and sanitize error message |
| 2025-12-30 | `2620dfa5` | +7/-2 | fix: sync floating input with AI provider settings |

## Size Evolution

```
2025-08-21: ████████████████████████████ 283 lines
2025-09-19: ██████████████████████████████ 309 lines
2025-09-21: ███████████████████████████████ 313 lines
2025-09-22: ████████████████████████████████ 328 lines
2025-09-22: ███████████████████████████████████ 351 lines
2025-09-22: ███████████████████████████████████ 351 lines
2025-09-23: ███████████████████████████████████ 351 lines
2025-09-25: ███████████████████████████████████ 351 lines
2025-10-08: ███████████████████████████████████ 353 lines
2025-10-13: ███████████████████████████████████ 353 lines
2025-10-20: ████████████████████████████████████ 368 lines
2025-11-28: ████████████████████████████████████ 368 lines
2025-12-02: ██████████████████████████████████████ 383 lines
2025-12-12: ██████████████████████████████████████ 384 lines
2025-12-13: ██████████████████████████████████████ 384 lines
2025-12-14: █████████████████████████████████████ 378 lines
2025-12-15: █████████████████████████████████████ 378 lines
2025-12-30: ██████████████████████████████████████ 383 lines
```

## Notable Patterns

### Large Changes

- **2025-08-21** (`36a0d18f`): +283/-0
  - "Open Beta Init"

## Verification Commands

```bash
# View full file history
git log --follow --stat -- "apps/web/src/app/api/ai/settings/route.ts"

# View specific commit diff
git show <commit-hash> -- "apps/web/src/app/api/ai/settings/route.ts"
```