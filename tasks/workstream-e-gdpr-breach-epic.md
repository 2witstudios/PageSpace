# Workstream E — GDPR Breach / Monitoring / Audit Hardening Epic

**Status**: 📋 PLANNED
**Goal**: Close the residual GDPR security-of-processing, breach-notification, and accountability gaps (Art 5(2), 30, 32, 33, 34) across breach pipeline, rate limiting/anomaly alerting, Art 30 record fields, admin-read auditing, realtime audience authz, search-PII runtime enforcement, AI-chat retention, calendar-cache erasure, and integration deployment-mode gating.

## Overview

Because the platform processes personal data at scale but still lacks a breach/incident pipeline, persists rate-limit state in a process-local Map, omits Art 30 record-of-processing fields, leaves privileged admin reads unaudited, trusts realtime broadcast callers without audience checks, only static-checks search PII, retains AI prompts indefinitely, keeps cached Google Calendar data after disconnect, and exposes integration routes regardless of deployment mode — these gaps create unmitigated confidentiality, minimization, and accountability risk. Sentry and the audit hash-chain alerting already exist and a Postgres-backed distributed limiter (`distributed-rate-limit.ts`) is already built; this epic integrates and extends that infrastructure rather than rebuilding it. Every leaf is TDD-first (a failing colocated test precedes code) and pure-core-first (deterministic business logic lives in pure functions; DB/network/fs stay at thin imperative edges).

---

## Phase A — Art 30 Record-of-Processing Fields (#980, medium)

### Add Art 30 columns to activity_logs schema

Extend `packages/db/src/schema/monitoring.ts` activityLogs with nullable Art 30 fields and generate the migration.

**Requirements**:
- Given an activity_logs insert, should persist `dataCategory`, `legalBasis`, `retentionPolicy`, and `recipients` columns (all nullable for backfill safety).
- Given a schema change, should produce a generated Drizzle migration (never hand-written SQL).

### Pure Art 30 classifier

A pure function mapping an operation + resourceType to its record-of-processing classification.

**Requirements**:
- Given an operation and resourceType, should return a deterministic `{ dataCategory, legalBasis, retentionPolicy, recipients }` record with no I/O.
- Given an unmapped operation/resourceType pair, should return a defined `unclassified` fallback rather than throwing.
- Given the same inputs twice, should return identical output (referential transparency proven by test).

### Populate Art 30 fields on activity-log write

Wire the classifier into the activity-log write edge so every new row carries its Art 30 classification.

**Requirements**:
- Given an activity-log write, should populate the four Art 30 fields from the pure classifier without altering existing hash-chain inputs.

---

## Phase B — Breach Notification Pipeline (#979, critical)

### Add incidents table schema

New `packages/db/src/schema/` table for security incidents/breaches plus generated migration.

**Requirements**:
- Given a breach is recorded, should persist severity, status, detectedAt, affected-subject scope, and notification-deadline fields in an `incidents` table.
- Given a schema change, should produce a generated Drizzle migration.

### Pure breach-assessment core

Pure functions for Art 33/34 obligations: 72-hour deadline computation and notifiability assessment.

**Requirements**:
- Given a detection timestamp, should compute the Art 33 supervisory-authority notification deadline at detectedAt + 72h with no I/O.
- Given an incident's risk profile, should decide whether supervisory-authority notification (Art 33) and data-subject notification (Art 34, "high risk") are required.
- Given an incident state and a requested transition, should accept only valid lifecycle transitions (detected → triaged → notified → closed) and reject invalid ones.

### Incident notify path (thin edge)

Service that creates an incident row and dispatches notifications via existing alerting, with logic delegated to the pure core.

**Requirements**:
- Given a new incident, should persist it and emit a security-audit event plus an alert through the existing alert-handler wiring.

### Breach response runbook

`docs/security/breach-runbook.md` documenting detection → assessment → notification → closure.

**Requirements**:
- Given an operator responding to a breach, should find the 72h Art 33 timeline, the Art 34 high-risk criterion, and the incident lifecycle states in the runbook.

---

## Phase C — Distributed Limiter Migration + Anomaly Alerting (#977, critical)

### Migrate auth callers off the in-process Map limiter

Replace `checkRateLimit`/`resetRateLimit`/`getRateLimitStatus` callers with the Postgres-backed distributed equivalents; deprecate the in-memory module.

**Requirements**:
- Given an auth endpoint enforcing a rate limit, should consult the Postgres-backed `checkDistributedRateLimit` so the limit survives restarts and spans replicas.
- Given the in-memory `rate-limit-utils` module, should no longer be imported by any production auth path.

### Pure auth-anomaly detector

Pure function classifying authentication-failure patterns into anomaly signals.

**Requirements**:
- Given a window of auth-failure counts for an identifier, should classify brute-force/credential-stuffing anomalies against defined thresholds with no I/O.
- Given normal traffic below threshold, should report no anomaly.

### Wire anomaly alerting into the auth-failure edge

Emit security-audit anomaly events + alert when the pure detector flags an anomaly.

**Requirements**:
- Given the detector flags an anomaly, should emit a `security.anomaly.detected` (or brute-force) audit event through the existing audit/alert path.

---

## Phase D — Admin-Read Auditing (#954, high)

### Pure admin-read audit-event builder + event type

Add an `admin.data.read` security event type and a pure builder for privileged-admin-read audit events.

**Requirements**:
- Given an admin reading another user's personal data, should build an immutable audit event capturing actor, target subject, resourceType, and which field-categories were accessed — as a pure function.
- Given the security event-type enum, should include a distinct privileged-admin-read event type separable from ordinary `data.read`.

### Emit audit events from unaudited admin reads

Wire the builder into admin routes that read user PII without auditing (`global-prompt`, `compaction`, and any DSAR-style reads).

**Requirements**:
- Given an admin route that reads user PII, should emit the privileged-admin-read audit event after a successful read.

---

## Phase E — Realtime Broadcast Audience Authz (#972, medium)

### Pure broadcast-audience authorization

Pure validator ensuring a signed broadcast targets an authorized audience/channel rather than trusting the caller wholesale.

**Requirements**:
- Given a broadcast payload, should validate that the target channel/audience is well-formed and within the signer's permitted scope as a pure function.
- Given a payload whose audience falls outside the permitted scope, should reject it.

### Enforce audience authz in the realtime broadcast handler

Wire the validator into `apps/realtime/src/index.ts` broadcast handling.

**Requirements**:
- Given a broadcast that fails audience authorization, should be refused (no emit) even when the HMAC signature is valid.

---

## Phase F — Search-PII Runtime Enforcement (#971, medium)

### Pure audit-details PII guard

Pure function that rejects/strips user-typed query text (and PII) from audit `details` at runtime.

**Requirements**:
- Given an audit details object containing a `query`/user-typed text field, should strip or reject it as a pure function.
- Given a clean details object, should pass it through unchanged.

### Wire runtime PII guard into search audit calls

Apply the guard at the search route audit edge; retain the existing static test.

**Requirements**:
- Given a search route emitting an audit event, should pass details through the runtime PII guard before persistence.

---

## Phase G — AI Chat Retention (#974, medium)

### Pure chat-retention eligibility core

Pure function computing the retention cutoff and which conversations/messages are eligible for purge.

**Requirements**:
- Given a now-timestamp and a retention window, should compute the purge cutoff and classify a record as eligible/retained with no I/O.
- Given a record newer than the cutoff, should classify it as retained.

### Schedule AI-chat purge sweep

Wire `purgeInactiveMessages`/`purgeInactiveConversations` (and inactive-chat purge) into a retention cron using the existing sweep pattern.

**Requirements**:
- Given the retention cron runs, should hard-delete soft-deleted chat records older than the configured window and emit a `data.delete` audit event.

---

## Phase H — Calendar Cache Erasure on Disconnect (#959, low)

### Pure calendar-cache deletion plan

Pure function enumerating the cached calendar artifacts to erase for a disconnecting user.

**Requirements**:
- Given a userId and connection, should enumerate the set of cached-calendar deletions (synced events, attendees, triggers, webhook channels, connection metadata) as pure data.

### Hard-delete cached calendar data on disconnect

Wire the deletion plan into the Google Calendar disconnect route.

**Requirements**:
- Given a user disconnects Google Calendar, should hard-delete cached synced events/attendees/triggers and clear connection cache fields, then emit a `data.delete` audit event.

---

## Phase I — Integration Deployment-Mode Gating (#960, medium)

### Pure integration deployment-mode guard

Pure predicate deciding whether integration routes are permitted for the current deployment mode.

**Requirements**:
- Given a deployment mode, should decide whether cloud integration routes (GitHub/OAuth providers) are permitted, returning false for onprem.

### Gate generic OAuth integration routes

Apply the onprem guard (404) to the generic user/drive/agent integration routes and OAuth callback that currently lack it.

**Requirements**:
- Given an onprem deployment, should return 404 from the generic OAuth integration routes that previously responded.

---
