# GDPR Erasure Hardening Epic

**Status**: 📋 PLANNED
**Goal**: Turn the synchronous, blocking, fire-and-forget account-erasure path into a durable, queued, SLA-tracked, force-deletable, fully-propagated Right-to-Erasure pipeline that produces legal evidence.

## Overview

Because the right to erasure (GDPR Art 17) is a legal obligation with a hard 30-day deadline (Art 12(3)), PageSpace cannot keep erasing accounts inside a single best-effort HTTP request that hard-blocks on multi-member drives, leaves no record of the request, and never propagates deletion to its email and AI sub-processors. This epic adds a `data_subject_requests` table to evidence the SLA, a durable pg-boss-backed erasure job with retry and completion tracking, an admin force-delete escalation for multi-member drives, sub-processor propagation (email-suppression sync + AI-provider erasure forwarding), and Art 17(3)(b) pseudonymization helpers for the append-only audit tables — all built pure-core-first with the business logic in deterministic functions and side effects pushed to thin edges.

Covers issues: #919 (DSR table + SLA), #906 (async/retry/completion), #908 (force-delete escalation), #913 (email suppression), #912 (AI-provider erasure), #985 (audit pseudonymization).

---

## Phase 1 — data_subject_requests table + SLA core (#919)

### DSR schema + migration

Add the `data_subject_requests` table and register it in the schema barrel + package exports.

**Requirements**:
- Given a user is deleted, should keep the DSR row (userId FK `onDelete: 'set null'`) and its denormalized `subjectEmail` so the request remains as evidence.
- Given a new schema subpath, should add an explicit `packages/db` exports entry and barrel re-export, then regenerate the migration via `bun run db:generate` (never hand-write SQL).

### SLA pure functions

`packages/lib/src/compliance/dsr/sla.ts` — deadline + status math.

**Requirements**:
- Given a failing test written first, should compute `computeSlaDeadline(receivedAt, slaDays=30)` as a pure deterministic function with no clock access (caller injects `receivedAt`).
- Given a request and an injected `now`, should classify `computeSlaStatus` into met/on_track/due_soon/overdue/breached without reading the system clock.
- Given a list of requests and `now`, should summarize compliance counts purely for admin visibility.

### DSR status machine

`packages/lib/src/compliance/dsr/status-machine.ts` — legal-state transitions.

**Requirements**:
- Given a failing test first, should expose a pure `canTransition(from, to)` that rejects illegal transitions (e.g. completed→in_progress) and `isTerminalStatus`.

### DSR repository

`packages/lib/src/repositories/data-subject-request-repository.ts` — thin DB edge.

**Requirements**:
- Given a unit test with a mocked DB, should create/update/find/list rows with no business logic beyond mapping (SLA + transition logic stays in the pure modules).

---

## Phase 2 — Erasure orchestration core + force-delete (#908, #906)

### Drive disposition core

`packages/lib/src/compliance/erasure/drive-disposition.ts` — decide solo vs multi-member vs forced.

**Requirements**:
- Given a failing test first and a pure function, should partition owned drives into solo (≤1 member, auto-delete) and multi-member, reading `forceDelete` from input.
- Given multi-member drives and `forceDelete=false`, should return `blocked=true` with the offending drive names (today's 400 behavior, now expressed purely).
- Given multi-member drives and `forceDelete=true`, should return `blocked=false` and include those drives in the deletion set (the escalation path).

### Erasure plan + error classification core

`packages/lib/src/compliance/erasure/erasure-plan.ts` — ordered idempotent step descriptor + retry classifier.

**Requirements**:
- Given a failing test first, should describe the erasure step sequence purely (order, best-effort vs fatal, idempotency key) without executing anything.
- Given an error, should purely classify it retryable vs terminal so the queue can decide to retry.

### Erasure runner edge

`packages/lib/src/compliance/erasure/run-erasure.ts` — executes the plan via injected dependencies, updates the DSR row.

**Requirements**:
- Given injected dependencies (DI) and a mocked DB, should run steps in plan order, record each step result on the DSR row, and mark the row completed/failed/blocked.
- Given a best-effort step that throws, should record the failure but not abort erasure; given a fatal step that throws, should stop and mark failed for retry.

---

## Phase 3 — Durable queue: async/retry/completion (#906)

### Processor account-erasure queue + worker

`apps/processor/src/workers/queue-manager.ts` + `apps/processor/src/api/erasure.ts` — register an `account-erasure` queue with retry/backoff and an enqueue route.

**Requirements**:
- Given pg-boss already exists in the processor, should reuse it (no new queue dependency) and register `account-erasure` with `retryLimit`/`retryBackoff` for durability.
- Given an enqueue HTTP call from web (service-scoped), should enqueue a job and return its jobId for storage on the DSR row.

### Web enqueue/execute wiring

`apps/web/src/app/api/account/route.ts` (DELETE) + `apps/web/src/app/api/internal/account-erasure/execute/route.ts`.

**Requirements**:
- Given a valid self-service DELETE, should create a `data_subject_requests` row, enqueue the durable job, and return 202 with the requestId instead of running erasure inline.
- Given the processor invokes the internal execute endpoint (service-token auth), should run the erasure runner in-process where Stripe/email/AI deps live and report status so pg-boss can retry on non-success.

---

## Phase 4 — Email-provider suppression sync (#913)

### Suppression payload core + Resend edge

`packages/lib/src/compliance/erasure/email-suppression.ts` (pure) + `.../sync-email-suppression.ts` (edge).

**Requirements**:
- Given a failing test first, should purely build the suppression entries (email + reason) for a deleted user, skipping in on-prem mode.
- Given the edge with a mocked email client, should call the provider suppression API best-effort and never block erasure on its failure.

---

## Phase 5 — AI-provider erasure forwarding (#912)

### AI erasure manifest core + edge

`packages/lib/src/compliance/erasure/ai-provider-erasure.ts` (pure) + executor edge in `apps/web/src/lib/ai/`.

**Requirements**:
- Given a failing test first, should purely build a per-provider erasure manifest (deletion-request vs rely-on-ZDR vs skip-local) from the providers a user touched and the deployment mode.
- Given the edge, should execute the manifest best-effort, recording a forwarded/ZDR evidence entry per provider without blocking erasure.

---

## Phase 6 — Art 17(3)(b) audit pseudonymization (#985)

### Pseudonymization patch core + safety guard

`packages/lib/src/compliance/erasure/pseudonymize.ts` (pure).

**Requirements**:
- Given a failing test first, should expose the constant activity-log patch (`actorEmail='erased@pseudonymized'`, `actorDisplayName=null`) and the security-audit patch (null out the non-hashed denormalized PII: ipAddress/userAgent/geoLocation/sessionId).
- Given a patch and the set of hash-chained columns, should purely assert the patch touches NO hash-chain/content field (fail loudly otherwise).

### Pseudonymization repository edges

`pseudonymizeActivityLogsForUser(userId)` + `pseudonymizeSecurityAuditLogForUser(userId)`.

**Requirements**:
- Given a mocked DB, should overwrite only the denormalized actor PII columns and return the count of rows pseudonymized.

### Admin-gated pseudonymize route + chain verification

`apps/web/src/app/api/admin/gdpr/pseudonymize/route.ts`.

**Requirements**:
- Given a non-admin or a missing confirmation token, should refuse (admin role + explicit confirmation required).
- Given a successful run, should self-audit to `security_audit_log` (who, which userId, legal basis) and run the hash-chain verifier before/after, failing loudly if the chain breaks.

### Runbook

`docs/security/gdpr-pseudonymization-runbook.md` + `docs/security/data-subject-request-runbook.md`.

**Requirements**:
- Given an operator fielding an Art 17 dispute, should document when to invoke pseudonymization, what evidence to collect, and what to report to the supervisory authority.

---

## Phase 7 — Admin SLA visibility (#919)

### Admin DSR list route

`apps/web/src/app/api/admin/gdpr/requests/route.ts`.

**Requirements**:
- Given an admin, should list DSRs with their computed SLA status (using the Phase 1 pure functions) so overdue requests are visible as evidence.
