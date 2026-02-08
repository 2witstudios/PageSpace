# Review Vector: Search UI

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- ui.mdc

## Scope
**Files**: `apps/web/src/components/search/**`
**Level**: component

## Context
PageSpace provides a search interface supporting multi-drive search with regex and glob patterns, surfacing pages, files, and mentions. The search UI must handle debounced input, progressive result loading, result highlighting, and keyboard navigation through results. Search interacts with the permission system to only show results the current user can access, and must gracefully handle large result sets without freezing the UI. The search component is likely invoked via a keyboard shortcut and rendered as an overlay or modal.
