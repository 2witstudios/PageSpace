# Review: Code Quality (`master...HEAD` working-tree changes)

## Scope Reviewed
- `packages/lib/src/integrations/index.ts`
- `packages/lib/src/integrations/providers/index.ts`
- `packages/lib/src/integrations/providers/index.test.ts`
- `packages/lib/src/integrations/providers/notion.ts`
- `packages/lib/src/integrations/providers/notion.test.ts`

## Findings

1. **[Critical][Fixed] `update_page` schema blocked valid Notion updates without `properties`**
   - **File:** `packages/lib/src/integrations/providers/notion.ts`
   - **Issue:** `update_page.inputSchema.required` forced `properties`, which prevented valid Notion PATCH operations that only set `archived`, `icon`, or `cover`.
   - **Impact:** Tool-level validation could reject legitimate write actions before request execution.
   - **Fix applied:** Required fields changed to `['page_id']`; tests updated to verify archive-only updates work without `properties`.

2. **[Medium] Registry tests are intentionally brittle due hardcoded provider counts**
   - **File:** `packages/lib/src/integrations/providers/index.test.ts`
   - **Issue:** Assertions like `toHaveLength(3)` require edits each time a provider is added.
   - **Impact:** Minor maintenance overhead and avoidable test churn.
   - **Recommendation:** Keep explicit provider presence checks and consider removing strict count assertions unless exact cardinality is a hard requirement.

## Summary
- Notion provider integration is wired correctly into exports and built-in registry.
- No `any` usage introduced in reviewed changes.
- Critical schema issue has been fixed in this branch.
