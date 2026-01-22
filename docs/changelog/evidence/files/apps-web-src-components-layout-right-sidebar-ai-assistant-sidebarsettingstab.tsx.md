# File Evolution: apps/web/src/components/layout/right-sidebar/ai-assistant/SidebarSettingsTab.tsx

> Generated: 2026-01-22T14:52:06.468Z

## Summary

- **Total Commits**: 30
- **Lines Added**: 1001
- **Lines Deleted**: 293
- **Net Change**: 708 lines

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
| 2025-11-28 | `458264c5` | +4/-4 | refactor: reorganize stores and hooks (Phase 4) |
| 2025-11-28 | `005f17a6` | +1/-1 | refactor: reorganize packages/lib and apps/web/src/lib into  |
| 2025-11-29 | `2771384d` | +38/-1 | feat(ai): add page tree context for workspace structure awar |
| 2025-11-29 | `f26fabf9` | +13/-25 | refactor(ai): centralize assistant settings in Zustand store |
| 2025-12-02 | `b9aa4d83` | +7/-0 | fix(ai): add MiniMax to Provider Status grid and sidebar set |
| 2025-12-13 | `2c0f27e5` | +1/-1 | refactor: migrate imports to use barrel files |
| 2025-12-14 | `4712588d` | +1/-1 | fix: use direct imports in client components to avoid server |
| 2025-12-17 | `86f67849` | +2/-5 | refactor(ui): remove bot and sparkle icons from agent select |
| 2025-12-27 | `884b2f8e` | +3/-3 | feat(ai): add MiniMax-M2.1 and upgrade GLM 4.7 as pro model  |
| 2026-01-14 | `cc44bef2` | +3/-9 | feat(ai): hide underlying model details from users (#200) |

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
2025-11-28: ██████████████████████████████████████████████████ 685 lines
2025-11-28: ██████████████████████████████████████████████████ 685 lines
2025-11-29: ██████████████████████████████████████████████████ 722 lines
2025-11-29: ██████████████████████████████████████████████████ 710 lines
2025-12-02: ██████████████████████████████████████████████████ 717 lines
2025-12-13: ██████████████████████████████████████████████████ 717 lines
2025-12-14: ██████████████████████████████████████████████████ 717 lines
2025-12-17: ██████████████████████████████████████████████████ 714 lines
2025-12-27: ██████████████████████████████████████████████████ 714 lines
2026-01-14: ██████████████████████████████████████████████████ 708 lines
```

## Notable Patterns

### Large Changes

- **2025-08-21** (`36a0d18f`): +337/-0
  - "Open Beta Init"
- **2025-11-25** (`d8ca9a91`): +124/-5
  - "for review"
- **2025-11-26** (`6dc1b118`): +8/-132
  - "refactor: decouple agent selection from GlobalChatContext"

## Verification Commands

```bash
# View full file history
git log --follow --stat -- "apps/web/src/components/layout/right-sidebar/ai-assistant/SidebarSettingsTab.tsx"

# View specific commit diff
git show <commit-hash> -- "apps/web/src/components/layout/right-sidebar/ai-assistant/SidebarSettingsTab.tsx"
```