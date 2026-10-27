# Personal Data Breach Response Runbook

**Scope:** GDPR Art 33 (notification to the supervisory authority) and Art 34
(communication to the data subject). This runbook is the operational procedure
that sits on top of the breach pipeline (`incidents` table + `createIncident`
service + `breach-assessment` pure core). Issue: #979.

> A **personal data breach** (Art 4(12)) is a breach of security leading to the
> accidental or unlawful destruction, loss, alteration, unauthorised disclosure
> of, or access to, personal data. It is classified along the CIA triad:
> **confidentiality**, **integrity**, **availability**.

---

## 0. Roles

- **First responder** — whoever detects/receives the report. Opens the incident.
- **Incident lead** — owns triage, the 72h clock, and the close-out.
- **DPO / privacy owner** — owns the Art 33 authority notification and the Art 34
  subject communication decision.

---

## 1. Detect → open an incident (status: `detected`)

The moment the controller becomes **aware** of a likely breach, the Art 33 clock
starts. Do not wait for full root-cause before opening the record.

Record it via the pipeline so the 72h deadline and obligations are computed and
audited automatically:

```ts
import { createIncident } from '@pagespace/lib/incidents/incident-service';

await createIncident({
  title: 'Short factual summary',
  severity: 'high',          // internal triage scale: low | medium | high | critical
  category: 'confidentiality', // confidentiality | integrity | availability
  riskLevel: 'high',         // residual risk to data subjects: low | medium | high
  involvesPersonalData: true,
  affectedUserCount: 1200,   // best estimate; refine during triage
  affectedScope: { dataCategories: ['email', 'content'], drives: ['...'] },
  reportedBy: '<userId or null>',
  detectedAt: new Date(),    // when the controller became AWARE
});
```

`createIncident` persists the incident, writes an immutable
`security.incident.created` audit event (tamper-evident hash chain), logs an
operational alert, and fires the registered incident notifier (email/Slack).

**The 72-hour clock starts at `detectedAt`, not at incident-creation time.** If
awareness predated the record, pass the real `detectedAt`.

---

## 2. Triage & assess risk (status: `triaged`)

The pure core (`@pagespace/lib/incidents/breach-assessment`) encodes the
regulatory logic — confirm its inputs are right rather than re-deriving by hand:

- **`computeAuthorityNotificationDeadline(detectedAt)` → detectedAt + 72h.**
  This is the Art 33 deadline. It is stored on the incident as
  `authorityNotificationDeadline`.
- **`assessNotifiability({ riskLevel, involvesPersonalData })`:**
  - No personal data involved → neither notification applies.
  - `riskLevel: 'low'` → **Art 33 exemption** ("unlikely to result in a risk to
    the rights and freedoms of natural persons") → no authority notification.
  - `riskLevel: 'medium' | 'high'` → **authority notification required** (Art 33).
  - `riskLevel: 'high'` → **data-subject notification additionally required**
    (Art 34 — the breach is likely to result in a *high* risk to individuals).

Risk drivers to weigh when choosing `riskLevel`: type/sensitivity of data,
volume and identifiability of affected subjects, ease of re-identification,
severity of consequences, and whether mitigations (e.g. encryption that renders
data unintelligible) reduce the residual risk.

If triage changes the picture (more subjects, higher sensitivity), update the
incident and re-assess — the deadline does **not** move, but the obligations may.

---

## 3. Notify (status: `notified`)

### 3a. Supervisory authority — Art 33 (within 72h)

When `requiresAuthorityNotification` is true, the DPO must notify the lead
supervisory authority **without undue delay and, where feasible, no later than
72 hours** after `detectedAt`. The notification must describe:

1. The nature of the breach, categories and approximate number of data subjects
   and records concerned.
2. The DPO's name and contact point.
3. The likely consequences of the breach.
4. The measures taken or proposed to address it and mitigate adverse effects.

If full information is not available within 72h, notify within the deadline and
supply the remainder in phases. **If you miss 72h, you must still notify and
include the reasons for the delay** (Art 33(1)).

`isAuthorityNotificationOverdue(deadline, now)` flags overdue incidents; the
`idx_incidents_authority_deadline` index supports a "deadline approaching" sweep.

Stamp `authorityNotifiedAt` when done.

### 3b. Data subjects — Art 34 (high risk only)

When `requiresSubjectNotification` is true, communicate to affected subjects
**without undue delay**, in clear and plain language, covering items 2–4 above.
Exemptions (Art 34(3)): data was rendered unintelligible (e.g. encryption);
subsequent measures ensure the high risk is no longer likely; or it would
involve disproportionate effort (then use a public communication instead).

Stamp `subjectsNotifiedAt` when done.

---

## 4. Close out (status: `closed`)

Allowed lifecycle transitions (enforced by `isValidIncidentTransition`):

```
detected ──▶ triaged ──▶ notified ──▶ closed
   │            │
   └────────────┴──────────────────▶ closed   (early close: no notification needed)
```

Backwards transitions and skipping the notification step forward are rejected.
Before closing: confirm root cause documented, mitigations deployed, required
notifications stamped, and follow-up actions tracked. Set `closedAt`.

---

## 5. Records & accountability (Art 33(5))

The controller must **document all breaches**, comprising the facts, effects, and
remedial action — regardless of whether notification was required. The
`incidents` table plus the immutable `security.incident.created` audit event are
that record of processing for breaches. Do not delete or edit incident rows to
"clean up"; supersede with a follow-up incident if facts change materially.
