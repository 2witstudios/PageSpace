# Review Vector: Custom Hooks

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- ui.mdc

## Scope
**Files**: `apps/web/src/hooks/**`
**Level**: component

## Context
PageSpace has 30+ custom hooks spanning authentication, real-time sockets, device management, document handling, mobile support, and page agent coordination. Hooks like useActivitySocket, useGlobalDriveSocket, and useInboxSocket manage real-time connections while useDocument, useDrive, and usePage handle data fetching and mutations. Correct dependency arrays, cleanup functions, and memoization are essential since many hooks manage subscriptions or expensive computations. The hooks/page-agents/ directory contains specialized hooks for AI agent interactions.
