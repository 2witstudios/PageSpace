# Runbook: Data Subject Requests & Erasure SLA

**Issues:** #906, #908, #919, #913, #912 · **Articles:** GDPR Art 17(1), Art 12(3), Art 17(2), Art 21
**Audience:** Security/compliance operators + on-call

## Overview

Every Right-to-Erasure request is recorded in the `data_subject_requests` (DSR)
table and executed by a **durable, queued, retried** pipeline rather than a
single best-effort HTTP request. The DSR row is the legal evidence that the
request was received and resolved within the statutory **30-day** window
(Art 12(3)).

```
DELETE /api/account            (self-service)        ┐
POST  /api/admin/gdpr/erasure  (admin escalation)    ┴─► create DSR row (status=pending, slaDeadline=received+30d)
                                                          ├─ best-effort Stripe customer delete (web)
                                                          ├─ bump tokenVersion (lock the subject out now)
                                                          └─ enqueue pg-boss `account-erasure` job ─► status=queued
                                                                                                      │
processor worker (account-erasure, retry+backoff) ◄───────────────────────────────────────────────┘
   runs the erasure plan, recording each step on the DSR row:
   drive-disposition → delete-avatar → log → anonymize-activity-logs →
   purge-ai-usage → purge-monitoring → revoke-integrations →
   email-suppression (#913) → ai-provider-erasure (#912) → security-audit → delete-user
   → status = completed | blocked | failed
```

## Request lifecycle / statuses

| status | meaning |
|--------|---------|
| `pending` | DSR row created, not yet enqueued |
| `queued` | durable job enqueued; jobId stored on the row |
| `in_progress` | worker is executing steps |
| `blocked` | a multi-member drive blocked deletion and no force escalation was granted — **needs human action** |
| `completed` | erasure finished; `completedAt` set |
| `failed` | a fatal step failed after the worker's attempt; pg-boss retries with backoff up to the cap |
| `cancelled` | request withdrawn |

SLA standing (`met` / `on_track` / `due_soon` / `overdue` / `breached`) is
computed from `slaDeadline` + `completedAt` and surfaced by the admin endpoint.

## Self-service erasure (`DELETE /api/account`)

- Requires the user to type their exact email as `emailConfirmation`.
- If the user still **owns drives with other members**, the request is blocked
  with `400` and the offending drive names — they must transfer ownership or use
  the admin escalation. Self-service **cannot** orphan co-members.
- Otherwise returns `202` with `{ requestId, status: "queued", slaDeadline }`.
- Idempotent: a second request while one is in flight returns the existing one.

## Admin force-delete escalation (`POST /api/admin/gdpr/erasure`) — #908

The escape hatch when a subject owns multi-member drives and ownership transfer
is impossible. Admin-gated; requires an explicit typed confirmation:

```json
{ "userId": "<id>", "forceDelete": true, "legalBasis": "<ref>", "confirmation": "ERASE <id>" }
```

`forceDelete: true` deletes the subject's multi-member drives too (orphaning
co-members) so the Art 17 obligation can be met. The DSR row records that an
admin escalated and the legal basis.

## Monitoring the SLA (`GET /api/admin/gdpr/requests`) — #919

Returns every DSR with its computed `slaStatus` plus a `summary` of counts. Watch
for `overdue` / `due_soon` open requests and `blocked` rows.

### Handling a `blocked` request

1. Inspect `blockedReason` (the multi-member drive names).
2. Either help the subject transfer drive ownership, or run the admin
   force-delete escalation with `forceDelete: true`.
3. Re-enqueue is automatic on a new escalation request.

### Handling a `failed` request

pg-boss retries fatal failures with backoff up to the attempt cap. If a row is
still `failed` after retries, inspect `lastError` and `stepResults`, resolve the
underlying cause (e.g. DB connectivity), and lodge a fresh request — the prior
evidence row is retained.

## Sub-processor propagation

- **Email (#913):** on cloud/tenant, the worker suppresses the address at the
  email provider (Resend audience contact → `unsubscribed: true`). Requires
  `RESEND_API_KEY` + `RESEND_AUDIENCE_ID`; best-effort, never blocks erasure.
- **AI providers (#912):** the worker builds a per-provider manifest from the
  providers the user actually invoked. Gateway-routed cloud providers are
  recorded as ZDR-reliant; local providers are skipped; unrecognised providers
  are flagged `manual_review` in the step evidence — follow up manually.

## Audit-table pseudonymization

Erasure does **not** delete `activity_logs` / `security_audit_log` rows (the hash
chain must survive). If a supervisory authority disputes that retention, use
`docs/security/gdpr-pseudonymization-runbook.md`.
