# File Evolution: apps/web/src/components/layout/left-sidebar/page-tree/PageTree.tsx

> Generated: 2026-01-22T14:52:04.220Z

## Summary

- **Total Commits**: 12
- **Lines Added**: 1004
- **Lines Deleted**: 626
- **Net Change**: 378 lines

## Lifecycle Status

**✅ ACTIVE** - This file exists in the current codebase.

## Commit History

| Date | Commit | +/- | Message |
|------|--------|-----|---------|
| 2025-08-21 | `36a0d18f` | +307/-0 | Open Beta Init |
| 2025-08-24 | `68eeb411` | +14/-22 | sidebar starts clsoed |
| 2025-09-11 | `3734b5cc` | +89/-32 | drag and drop into sidebar |
| 2025-09-11 | `5090cdb3` | +73/-7 | working drag and drop even nested |
| 2025-09-11 | `ce63e21b` | +162/-50 | uploading documents done with proper drag and drop |
| 2025-09-12 | `2dccc06a` | +41/-20 | drag and drop when empty |
| 2025-09-12 | `18d761bb` | +0/-1 | page type refactor |
| 2025-10-08 | `0f828e3b` | +5/-8 | CSRF |
| 2025-11-28 | `005f17a6` | +1/-1 | refactor: reorganize packages/lib and apps/web/src/lib into  |
| 2025-12-02 | `81c81414` | +281/-469 | refactor(sidebar): simplify page tree with dnd-kit SortableT |
| 2025-12-03 | `fcebbf61` | +30/-15 | fix(sidebar): make drag-and-drop deterministic and prevent h |
| 2025-12-17 | `89c56889` | +1/-1 | refactor(sidebar): convert 3-dot menu to right-click context |

## Size Evolution

```
2025-08-21: ██████████████████████████████ 307 lines
2025-08-24: █████████████████████████████ 299 lines
2025-09-11: ███████████████████████████████████ 356 lines
2025-09-11: ██████████████████████████████████████████ 422 lines
2025-09-11: ██████████████████████████████████████████████████ 534 lines
2025-09-12: ██████████████████████████████████████████████████ 555 lines
2025-09-12: ██████████████████████████████████████████████████ 554 lines
2025-10-08: ██████████████████████████████████████████████████ 551 lines
2025-11-28: ██████████████████████████████████████████████████ 551 lines
2025-12-02: ████████████████████████████████████ 363 lines
2025-12-03: █████████████████████████████████████ 378 lines
2025-12-17: █████████████████████████████████████ 378 lines
```

## Notable Patterns

### Large Changes

- **2025-08-21** (`36a0d18f`): +307/-0
  - "Open Beta Init"
- **2025-09-11** (`ce63e21b`): +162/-50
  - "uploading documents done with proper drag and drop"
- **2025-12-02** (`81c81414`): +281/-469
  - "refactor(sidebar): simplify page tree with dnd-kit SortableTree pattern"

## Verification Commands

```bash
# View full file history
git log --follow --stat -- "apps/web/src/components/layout/left-sidebar/page-tree/PageTree.tsx"

# View specific commit diff
git show <commit-hash> -- "apps/web/src/components/layout/left-sidebar/page-tree/PageTree.tsx"
```