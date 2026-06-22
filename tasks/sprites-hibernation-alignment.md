# Sprites Hibernation-Model Alignment Epic

**Status**: 📋 PLANNED
**Goal**: Make the Fly Sprites sandbox + terminal implementation match the Sprites hibernate-and-wake model and the `@fly/sprites` SDK's documented usage, so agent sandboxes and terminals stay reachable instead of being destroyed or hung.

## Overview

WHY: agents lose their sandbox mid-conversation and terminals get stuck "Connecting to shell…" because the implementation fights the platform. Sprites are *persistent environments that hibernate when idle and wake automatically on demand*; instead we destroy hibernated VMs on a 15-minute idle timer (discarding agent state and churning into delete/recreate races and rate limits), call file I/O through a timeout-less HTTP path that hangs on a cold VM, never retry the documented cold-start wake handshake, run the terminal service on a Node version the SDK forbids, and flatten every control-plane failure into one opaque `provision_failed`. This epic aligns each of those with the platform's intended lifecycle and ships it as one PR.

---

## Realtime runtime alignment

Bump the realtime service to the Node version the SDK requires and make the terminal path fail loudly instead of hanging.

**Requirements**:
- Given `@fly/sprites` requires Node >= 24, when the realtime image is built, it should run on Node 24 (builder and runner), matching the web image.
- Given a Node < 24 runtime, when the terminal sprite path is exercised, it should throw an actionable runtime error rather than silently hang the WebSocket connect.
- Given the stale comment claiming "Node 22.17.0 handles it natively", it should be corrected to reflect the Node 24 requirement.

---

## Idle hibernation instead of destroy

Stop destroying hibernated conversation VMs on idle; resume and let the platform wake them.

**Requirements**:
- Given a conversation sandbox idle past the warm window, when the next command arrives, it should resume + wake the hibernated VM rather than delete and recreate it.
- Given a genuine session-end intent, when teardown runs, it should still destroy the VM (no orphan billing).
- Given a much-longer hard-expiry ceiling, when a sandbox exceeds it, it should be torn down so abandoned sessions are eventually reclaimed.
- Given the resume path, when the recorded VM has genuinely vanished (404), it should re-provision under the same key.

---

## Terminal persistent sessions

Treat idle terminal sessions as hibernating, not disposable.

**Requirements**:
- Given the terminal lifecycle planner, when a session is idle, it should return `noop` (hibernate) instead of `teardown`, by passing `persistent: true`.

---

## Cold-start file I/O robustness

Make `writeFile`/`readFile` survive a cold/hibernated VM the same way command execution does.

**Requirements**:
- Given a cold/hibernated VM, when `writeFile` or `readFile` runs, it should not hang indefinitely — the operation should be bounded by a timeout and wake the VM via the designated path.
- Given a transient cold-start failure, when a file op fails before the VM is ready, it should retry within the bound rather than surface a hard failure on the first attempt.

---

## Cold-start exec retry

Retry the documented wake handshake instead of failing the first command after hibernation.

**Requirements**:
- Given an exec WebSocket that closes before opening (the wake handshake), when a command runs against a hibernating VM, it should retry with backoff before failing.
- Given a non-transient error (auth, non-zero exit, output overflow, timeout), when it occurs, it should NOT be retried.

---

## Resource caps on creation

Actually apply the resource caps the driver claims to set.

**Requirements**:
- Given a resolved sandbox policy with RAM/vCPU/region/storage, when a sprite is created, those caps should be passed to `createSprite` rather than relying on platform defaults.
- Given the create options type, it should carry the cap config so the comment and the behavior agree.

---

## Provisioning error classification

Stop flattening distinct control-plane failures into one opaque reason.

**Requirements**:
- Given a creation/concurrent rate-limit error from the API, when provisioning fails, it should surface a distinct rate-limited reason with `retryAfter` rather than a generic `provision_failed`.
- Given a name-conflict / delete-recreate race, when provisioning fails, it should be distinguishable from a true infrastructure failure in logs and tool output.

---

## Verify and open PR

Validate the whole change and open a single PR.

**Requirements**:
- Given the full change set, when validation runs, `bun run typecheck` and `bun run lint` should pass and the sandbox/terminal unit tests should be green.
- Given the completed work, when the PR is opened, it should describe each root cause (C1–C4, H1–H3) and how it was addressed, and update the changelog.
