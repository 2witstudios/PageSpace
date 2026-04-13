# GDPR Audit — Index

Full GDPR audit of PageSpace conducted across four parallel streams on
2026-04-12. Every finding is grounded in a specific GDPR article and a
`file:line` citation. Read-only audit — no source code was modified to
produce these docs. Spec at [`tasks/gdpr-audit.md`](../../../tasks/gdpr-audit.md).

## Streams

| # | Focus | GDPR articles | Doc |
|---|---|---|---|
| 1 | Data subject rights + retention + erasure | Art 5(1)(e), 12(3), 15, 16, 17, 17(2), 17(3)(b), 18, 20, 21 | [`01-dsr-retention.md`](./01-dsr-retention.md) |
| 2 | Consent, lawful basis, legal pages | Art 6, 7, 8, 12–14, 22, 25, 27, 30, 35, 37 | [`02-consent-legal.md`](./02-consent-legal.md) |
| 3 | Processors + cross-border transfers | Art 28, 29, 30, 44–49 | [`03-processors-transfers.md`](./03-processors-transfers.md) |
| 4 | Data minimization + security + breach | Art 5(1)(c), 25, 32, 33, 34 | [`04-minimization-breach.md`](./04-minimization-breach.md) |

## Headline counts

| Stream | Critical / P0 | High / P1 | Medium / P2 | Low |
|---|---|---|---|---|
| 1 — DSR/retention | 5 | 6 | ~12 | — |
| 2 — Consent/legal | — | 6 | 8 | 5 |
| 3 — Processors | 3 | 10 | 9 | 2 |
| 4 — Minimization/breach | 5 | 5 | 5 | — |

## Load-bearing findings

Four finding clusters block lawful EU operation today:

1. **F4.13 + F4.15** — No breach detection, no incident model, no
   notification runbook. A GDPR breach today could not be reported within
   72h as Art 33 requires.
2. **F-17-2 + F-17-2-1..4** — Erasure cannot complete without manual
   engineering intervention; multi-member drives hard-block with HTTP 400;
   Stripe / OAuth / AI / email processors are never notified on erasure
   (Art 17(2) violation).
3. **F3.9 + F3.11** — No DPA register and no Art 30 record of processing
   exist anywhere in the repo or deploy repo.
4. **F4.5b + F4.2** — Internal service-to-service traffic is plaintext
   HTTP; onprem/tenant file storage has no application-layer encryption at
   rest.

## Deferred — provider migration track

All ~14 provider-related findings in Stream 3 (F3.1 Z.AI default, F3.2 AI
request minimization, F3.3–F3.8 processor DPAs, F3.12, F3.15, F3.20, F3.21,
F3.23, F3.24) are parked pending a broader provider strategy review and are
tracked in issues labeled `gdpr:provider-deferred`. Governance items from
Stream 3 (F3.9 DPA register, F3.11 RoPA, F3.13 controller breach plumbing,
F3.14 operator-action audit) remain in the active backlog because they are
documentation + audit-trail work, not provider migration.

## Methodology

- 4 parallel worktree agents, each in plan mode
- Every finding cites a GDPR article + `file:line`
- Every finding tagged with deployment-mode impact (`cloud`, `onprem`,
  `tenant`, or combinations)
- Severity scale per stream: critical/high/medium/low (streams 2–4) or
  P0/P1/P2 (stream 1)
- Each doc ends with a "Checklist of what was examined" enumerating every
  file inspected
