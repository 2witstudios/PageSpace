# File Evolution: apps/web/src/components/layout/right-sidebar/ai-assistant/AssistantSettingsTab.tsx

> Generated: 2026-01-22T14:52:00.885Z

## Summary

- **Total Commits**: 21
- **Lines Added**: 928
- **Lines Deleted**: 928
- **Net Change**: 0 lines

## Lifecycle Status

**✅ ACTIVE** - This file exists in the current codebase.

## Commit History

| Date | Commit | +/- | Message |
|------|--------|-----|---------|
| 2025-08-21 | `36a0d18f` | +337/-0 | Open Beta Init |
| 2025-08-21 | `9d63a049` | +6/-4 | admin auth |
| 2025-09-19 | `a8aac666` | +98/-12 | Ollama support, batch fixes |
| 2025-09-22 | `5eca9459` | +10/-3 | GLM working |
| 2025-09-22 | `6c705e9e` | +90/-7 | GLM as default model |
| 2025-09-22 | `4d07ee4d` | +1/-1 | New pricing |
| 2025-09-30 | `6f538620` | +6/-6 | big updates |
| 2025-10-01 | `20f8c9bb` | +4/-4 | glm update |
| 2025-10-08 | `0f828e3b` | +10/-29 | CSRF |
| 2025-10-08 | `a0049f12` | +3/-3 | fixed crsf |
| 2025-10-13 | `b998ed76` | +1/-1 | fix glm model name fix |
| 2025-10-20 | `f5b120dc` | +51/-3 | working response |
| 2025-10-21 | `42010861` | +2/-0 | lm studio recognized in sidebar |
| 2025-10-21 | `3b7b1572` | +27/-18 | lm studio model selector working on refresh |
| 2025-11-25 | `d8ca9a91` | +124/-5 | for review |
| 2025-11-25 | `83e9f310` | +13/-2 | refactor: use local state for agent mode in GlobalAssistantV |
| 2025-11-26 | `6dc1b118` | +8/-132 | refactor: decouple agent selection from GlobalChatContext |
| 2025-11-26 | `29578ac5` | +94/-5 | feat: add sidebar agent selection with independent state |
| 2025-11-28 | `d3d827e7` | +42/-7 | feat: refactor sidebar AI control with Zustand tab sync and  |
| 2025-11-28 | `f5e41faf` | +1/-1 | refactor: reorganize AI codebase for semantic clarity (WIP) |
| 2025-11-28 | `458264c5` | +0/-685 | refactor: reorganize stores and hooks (Phase 4) |

## Size Evolution

```
2025-08-21: █████████████████████████████████ 337 lines
2025-08-21: █████████████████████████████████ 339 lines
2025-09-19: ██████████████████████████████████████████ 425 lines
2025-09-22: ███████████████████████████████████████████ 432 lines
2025-09-22: ██████████████████████████████████████████████████ 515 lines
2025-09-22: ██████████████████████████████████████████████████ 515 lines
2025-09-30: ██████████████████████████████████████████████████ 515 lines
2025-10-01: ██████████████████████████████████████████████████ 515 lines
2025-10-08: █████████████████████████████████████████████████ 496 lines
2025-10-08: █████████████████████████████████████████████████ 496 lines
2025-10-13: █████████████████████████████████████████████████ 496 lines
2025-10-20: ██████████████████████████████████████████████████ 544 lines
2025-10-21: ██████████████████████████████████████████████████ 546 lines
2025-10-21: ██████████████████████████████████████████████████ 555 lines
2025-11-25: ██████████████████████████████████████████████████ 674 lines
2025-11-25: ██████████████████████████████████████████████████ 685 lines
2025-11-26: ██████████████████████████████████████████████████ 561 lines
2025-11-26: ██████████████████████████████████████████████████ 650 lines
2025-11-28: ██████████████████████████████████████████████████ 685 lines
2025-11-28: ██████████████████████████████████████████████████ 685 lines
2025-11-28:  0 lines
```

## Notable Patterns

### Large Changes

- **2025-08-21** (`36a0d18f`): +337/-0
  - "Open Beta Init"
- **2025-11-25** (`d8ca9a91`): +124/-5
  - "for review"
- **2025-11-26** (`6dc1b118`): +8/-132
  - "refactor: decouple agent selection from GlobalChatContext"
- **2025-11-28** (`458264c5`): +0/-685
  - "refactor: reorganize stores and hooks (Phase 4)"

## Verification Commands

```bash
# View full file history
git log --follow --stat -- "apps/web/src/components/layout/right-sidebar/ai-assistant/AssistantSettingsTab.tsx"

# View specific commit diff
git show <commit-hash> -- "apps/web/src/components/layout/right-sidebar/ai-assistant/AssistantSettingsTab.tsx"
```