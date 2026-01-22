# File Evolution: apps/web/src/contexts/GlobalChatContext.tsx

> Generated: 2026-01-22T14:52:00.814Z

## Summary

- **Total Commits**: 20
- **Lines Added**: 701
- **Lines Deleted**: 441
- **Net Change**: 260 lines

## Lifecycle Status

**✅ ACTIVE** - This file exists in the current codebase.

## Commit History

| Date | Commit | +/- | Message |
|------|--------|-----|---------|
| 2025-10-13 | `b896adda` | +216/-0 | Much better state that isnt lost moving around with global a |
| 2025-10-13 | `2c2ca74e` | +11/-7 | fixed history |
| 2025-10-14 | `de9120f4` | +25/-11 | state updates |
| 2025-10-20 | `2f456035` | +45/-68 | fixed broken stream |
| 2025-10-20 | `3bcb027e` | +29/-5 | so close to proper shared state |
| 2025-10-20 | `dffd9bd8` | +9/-0 | fixed shared ai streaming and global state |
| 2025-10-20 | `ebf8b975` | +14/-3 | fixed something that should help with state and flashing |
| 2025-11-25 | `d8ca9a91` | +186/-2 | for review |
| 2025-11-25 | `c7cca4a5` | +3/-3 | Use server’s conversationId field when creating agent chat |
| 2025-11-25 | `2e67231f` | +44/-6 | fix: restore agent conversation on page refresh |
| 2025-11-25 | `83e9f310` | +57/-170 | refactor: use local state for agent mode in GlobalAssistantV |
| 2025-11-26 | `6dc1b118` | +46/-146 | refactor: decouple agent selection from GlobalChatContext |
| 2025-11-28 | `f5e41faf` | +1/-1 | refactor: reorganize AI codebase for semantic clarity (WIP) |
| 2025-11-28 | `458264c5` | +2/-2 | refactor: reorganize stores and hooks (Phase 4) |
| 2025-11-28 | `60ce27bb` | +3/-3 | refactor: reorganize API routes under /api/ai (Phase 5) |
| 2025-11-28 | `005f17a6` | +1/-1 | refactor: reorganize packages/lib and apps/web/src/lib into  |
| 2025-12-13 | `2c0f27e5` | +1/-1 | refactor: migrate imports to use barrel files |
| 2025-12-14 | `4712588d` | +1/-1 | fix: use direct imports in client components to avoid server |
| 2025-12-19 | `ca507e7b` | +6/-11 | refactor: extract URL state and agent conversation helpers ( |
| 2026-01-13 | `922485a1` | +1/-0 | feat(chat): implement virtualized message lists and paginati |

## Size Evolution

```
2025-10-13: █████████████████████ 216 lines
2025-10-13: ██████████████████████ 220 lines
2025-10-14: ███████████████████████ 234 lines
2025-10-20: █████████████████████ 211 lines
2025-10-20: ███████████████████████ 235 lines
2025-10-20: ████████████████████████ 244 lines
2025-10-20: █████████████████████████ 255 lines
2025-11-25: ███████████████████████████████████████████ 439 lines
2025-11-25: ███████████████████████████████████████████ 439 lines
2025-11-25: ███████████████████████████████████████████████ 477 lines
2025-11-25: ████████████████████████████████████ 364 lines
2025-11-26: ██████████████████████████ 264 lines
2025-11-28: ██████████████████████████ 264 lines
2025-11-28: ██████████████████████████ 264 lines
2025-11-28: ██████████████████████████ 264 lines
2025-11-28: ██████████████████████████ 264 lines
2025-12-13: ██████████████████████████ 264 lines
2025-12-14: ██████████████████████████ 264 lines
2025-12-19: █████████████████████████ 259 lines
2026-01-13: ██████████████████████████ 260 lines
```

## Notable Patterns

### Large Changes

- **2025-10-13** (`b896adda`): +216/-0
  - "Much better state that isnt lost moving around with global assistant"
- **2025-11-25** (`d8ca9a91`): +186/-2
  - "for review"
- **2025-11-25** (`83e9f310`): +57/-170
  - "refactor: use local state for agent mode in GlobalAssistantView"
- **2025-11-26** (`6dc1b118`): +46/-146
  - "refactor: decouple agent selection from GlobalChatContext"

### Candid Developer Notes

- **2025-10-20**: "fixed broken stream"

## Verification Commands

```bash
# View full file history
git log --follow --stat -- "apps/web/src/contexts/GlobalChatContext.tsx"

# View specific commit diff
git show <commit-hash> -- "apps/web/src/contexts/GlobalChatContext.tsx"
```