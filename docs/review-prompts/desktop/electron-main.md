# Review Vector: Electron Main Process

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)

## Scope
**Files**: `apps/desktop/src/main/**`
**Level**: service

## Context
The Electron main process manages window creation, lifecycle events, auto-updates, and native OS integrations for the PageSpace desktop app. Review that window management handles multi-window scenarios correctly, that the app quits cleanly on all platforms, and that IPC channels between main and renderer are minimal and well-defined. Deep linking and protocol handler registration should also be verified.
