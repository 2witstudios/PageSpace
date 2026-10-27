# Runbook: Art 17(3)(b) Audit-Log Pseudonymization

**Applies to:** `activity_logs`, `security_audit_log`
**Issue:** #985 · **Articles:** GDPR Art 17, Art 17(3)(b), Art 5(1)(c)
**Audience:** Security/compliance operators with admin role

## When to invoke

Invoke this path **only** when a supervisory authority (or the data subject,
escalated) **disputes** PageSpace's retention of a user's rows in the two
append-only audit tables under the legal-obligation / legal-claims exemption
(Art 17(3)(b)).

This is **not** part of normal account deletion. Standard erasure
(`DELETE /api/account`, or the admin escalation `POST /api/admin/gdpr/erasure`)
already deletes or anonymizes every user-scoped table that can be deleted. The
two audit tables are deliberately retained because their tamper-evident hash
chain must stay intact to be evidentially useful — deleting rows would break the
chain and destroy that value.

Pseudonymization is the answer to the dispute: it removes the denormalized actor
PII **without** deleting rows or disturbing the hash chain.

## What it does (and does not) touch

| Table | Overwritten | Never touched |
|-------|-------------|---------------|
| `activity_logs` | `actorEmail` → `erased@pseudonymized`, `actorDisplayName` → `null`, `resourceTitle` → `null` (can carry the subject's own PII, e.g. their email on an `account_delete` row — #541) | hash inputs (`operation`, `resourceType`, `resourceId`, `driveId`, `pageId`, `contentSnapshot`, `previousValues`, `newValues`, `metadata`, `timestamp`, `id`), chain columns (`logHash`, `previousLogHash`, `chainSeed`, `chainSeq`) |
| `security_audit_log` | `ipAddress`, `userAgent`, `geoLocation`, `sessionId` → `null` | hash inputs (`eventType`, `serviceId`, `resourceType`, `resourceId`, `details`, `riskScore`, `anomalyFlags`, `timestamp`), chain columns (`eventHash`, `previousHash`, `chainSeq`) |

`userId` on both tables is `onDelete: 'set null'`, so it drops automatically when
the user is erased; pseudonymization additionally clears the denormalized columns
that survive that cascade.

The patch is defined purely in
`packages/lib/src/compliance/erasure/pseudonymize.ts` and is guarded at runtime
by `assertPseudonymizationPatchSafe`, which throws if the patch ever names a
hash-chained column. **Row deletion is intentionally not offered.**

## How to run

`POST /api/admin/gdpr/pseudonymize` (admin role required):

```json
{
  "userId": "<subject user id>",
  "legalBasis": "<reference to the dispute / supervisory-authority ticket>",
  "confirmation": "PSEUDONYMIZE <subject user id>"
}
```

The route:

1. Verifies **both** hash chains are intact *before* doing anything. If a chain
   is already broken it refuses (`409`) — fix the pre-existing problem first.
2. Applies the denormalized-actor-only patches and counts rows.
3. Re-verifies both chains. Pseudonymization touches no hash input, so this
   **must** pass; if it does not, the route returns `500` with the break point —
   treat as a P1 incident.
4. Self-audits the run to `security_audit_log` (`eventType: data.write`,
   `details.action: art17_pseudonymization`) recording the admin, the subject
   `userId`, the legal basis, and the per-table row counts.

## Evidence to collect for the supervisory authority

- The `200` response payload (row counts + `chainIntact: true`).
- The self-audit `security_audit_log` entry id (proves who ran it, when, and why).
- A fresh `GET /api/admin/audit/chain-verify` (or equivalent) result showing the
  chain remains valid after the run.
- The `legalBasis` reference you supplied, tying the action to the dispute.

Report to the authority: the actor PII has been pseudonymized; the residual rows
are retained solely for the integrity of the tamper-evident audit chain under
Art 17(3)(b); no content or identifying actor field remains.

## If the chain breaks (step 3 fails)

This should be impossible by construction. If it happens:

1. Do **not** run again.
2. Capture the `500` payload (`activityBreakPoint` / `securityBreakPoint`).
3. Open a P1 — a hash input column was likely changed elsewhere, or a row was
   deleted out of band. Investigate before any further audit-table writes.

## Cross-reference

See `docs/security/audit-log-retention-policy.md` §"Per-user erasure path" (when
present) — this runbook is the concrete execution of the pseudonymization
fallback that policy promises. See also
`docs/security/data-subject-request-runbook.md` for the standard erasure SLA flow.
