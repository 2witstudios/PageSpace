# Review Vector: Security Preload

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)

## Scope
**Files**: `apps/desktop/src/preload/**`, `apps/desktop/src/main/**`
**Level**: service

## Context
Preload scripts form the security boundary between the Electron renderer and the Node.js main process using context isolation and contextBridge. Review that no Node.js APIs leak into the renderer, that the exposed API surface is minimal and well-typed, and that all IPC messages are validated in the main process before acting on them. Verify that contextIsolation and sandbox settings are correctly enabled.
