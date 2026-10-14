# Finding, fix and evidence matrix

The original [independent review](https://pagespace.ai/dashboard/omziyxp4skckh7ixi2sxzhuk/qjkrah3b36h63ryneycq6mqu)
reported 18 findings at `dc32f26bf6b44ea2f94d928826f4d27648ba5fb3` (carried to `02f7a623`).
Corrections already existed at starting SHA `9ba6f806485656888189a095a922954421d721a5`.
This batch verifies them and repairs additional failures. The final handoff records the exact candidate SHA,
commands, logs and pass/fail/not-exercised results for **every row**. Until then, entries below identify
acceptance targets and retained controls, not a final independent clearance.

The original lane reports and negative-control descriptions were recovered from PageSpace. The attached
original probe ZIP could not be downloaded with the available content credential (the download endpoint
returned 401). Directly replaying that exact archive is **not exercised**; reconstructed and retained
production-path regressions below must be distinguished from its original executables.

## The original 18 findings

| Finding | Corrective implementation | Acceptance execution and retained control | Evidence boundary |
| --- | --- | --- | --- |
| ARCH-1 | Shared transactional wallet rehoming during org closure | `packages/lib/src/organizations/__tests__/org-deletion-wallets.integration.test.ts`: preserve 777 cents, donation legs, ledger and new personal owner; live holds refuse and roll back closure | Real PG/domain services; subscription cancellation port substituted |
| ARCH-2 | Capture previous audience and publish access/policy invalidation after a drive transition | `packages/lib/src/services/__tests__/drive-transition-invalidation.integration.test.ts` and `org-drive-service.integration.test.ts`: changed audience is re-evaluated; lost access is revoked, retained access kept | Real PG/service, captured transport; no claim of a captured live leaked packet |
| ARCH-3 | Session-only wallet rehoming/forgiveness admission | `packages/lib/src/services/__tests__/org-drive-service.integration.test.ts` plus credential route/service suites: keys refused for funded moves; session transitions preserve history | Credential decoding is a boundary; preserve refused-key and admitted-session controls |
| ARCH-4 | Read and lock current membership inside the policy transaction | `apps/web/src/app/api/orgs/[orgId]/policies/__tests__/authority.integration.test.ts`: real Admin session, stalled native Request body, committed removal → 404/no policy mutation; Owner control → 200 | Real opaque sessions, CSRF, Request stream, handler and PG; removed membership is canonically concealed with 404 |
| SEC-R1 | Admit supplemental calendar/RSVP content against actor and model policy before reading it into Pulse | `apps/web/src/app/api/pulse/__tests__/source-admission.integration.test.ts` and `calendar-provenance.integration.test.ts`: forbidden attendee/RSVP markers absent; personal control retained | Real policies, funded reservation and factory; deterministic model boundary, no external model transport |
| SEC-R2 | Admit reused summary provenance and retain it transitively on derived output | Same Pulse suites: forbidden prior summary omitted; allowed prior provenance retained; later tightening withholds derived summary and export | Real policy/storage/export admission; whole provider transport/full export delivery not claimed |
| SEC-R3 | Recheck every distinct policy notice instead of org-ID time-window deduplication | `apps/realtime/src/__tests__/org-room-watch.test.ts`: rapid distinct changes both recheck; authorized control retains rooms | Exact runtime modules with controlled socket, clock and reader |
| SEC-R4 | Enforce last-known credential expiry independently of failed policy rereads | Same watcher plus `org-room-expiry.test.ts`: known expired rooms revoked on read failure; unexpired/no-expiry read errors retry | Controlled runtime dependencies, not a launched network leak test |
| MONEY-1 | Count parent-backed child reservations when admitting donations | `packages/lib/src/billing/__tests__/wallet-funding.integration.test.ts`: root- and child-backed hold variants refuse an unbacked transfer, leaving funds for settlement | Real gate/donation/settlement and PG, not mocked balances |
| MONEY-2 | Distinct delayed invoices grant once without rewinding current periods/allowance | `apps/web/src/app/api/stripe/webhook/__tests__/personal-renewal.integration.test.ts`: signed October then September events, replay, real HMAC-authenticated hourly allocation endpoint at November; child resets. Lib `personal-invoice-renewal.integration.test.ts` pins root value | Real handlers/PG/signature validation; personal invoice fixture is synthetic and external receipt delivery substituted |
| MONEY-3 | Seal and durably upload topology before draining; restore it on a fresh runner | `scripts/__tests__/fly-billing-cutover.test.ts`, `fly-billing-restore.test.ts` and `infrastructure/__tests__/billing-cutover.test.ts`: copy to fresh runner, counts by process/region, corruption/wrong candidate/incomplete refusal, upload-before-drain and explicit original run ID | Real scripts with stateful fake Fly; no live drain. Final images tied to full candidate SHA |
| JOURNEYS-1 | Separate absolute personal-credit switches from defeasible default preferences | `apps/e2e/tests/33-org-spend-surfaces.spec.ts`: visible global absolute switch persists after reload; ordinary org conversation charges personal ledger only. Retained global/per-drive service/UI controls remain tested | Production browser, real PG/charge settlement; AI provider is local mock |
| JOURNEYS-2 | Resolve and display source before dispatch; pause Send, Enter and side questions while unresolved | Added classic/native browser scenarios in specs 33/37: actual 503 previews, no charge, retry displays source before the real charge; `ChatInput.btw.test.tsx` covers `/btw` bypass and editable draft | Production web/Imago + PG, fake AI. Service workers blocked for the classic fault injection so 503 interception is real |
| JOURNEYS-3 | Per-user preference announcement invalidates other windows' payer previews | Spec 33: two independent contexts on the SAME conversation; first changes source, second updates without reload/focus and charges exactly its displayed personal wallet. `wallet-change-events.test.ts` retains broadcast-failure containment | Real Socket.IO, browser and ledger; local fake provider; realtime and web must use the same isolated DB and broadcast secret |
| HIST-01 | Carry cost-correction debt outcome out of the transaction and notify the funder after commit | `packages/lib/src/billing/__tests__/cost-reconcile.integration.test.ts`: debt creates notice once, retry does not duplicate, no-debt control does not notify | Real reconciliation and notice claims; notification transport bounded by fixture |
| HIST-02 | Export every authorized donation through deterministic keyset batches | `packages/lib/src/compliance/export/__tests__/orgs-wallets-export.integration.test.ts`: 10,001 subject legs emitted uniquely in order; foreign donor excluded. Cleanup observes the funded-wallet invariant | Real PG/collector, actual original row-limit counterexample; no single capped query claim |
| HIST-03 | Settle aggregate tool-loop usage (`totalUsage`) | `apps/web/src/lib/workflows/__tests__/workflow-executor.test.ts` and `automation-executors-spend.integration.test.ts`: aggregate usage flows into real monitoring/settlement/caps; last-round undercharge control remains | Executor/provider output boundary substituted; PG sink/settlement real |
| MONEY-4 | Preserve included funding composition in legs, transfers, consumption and liability | `packages/lib/src/billing/__tests__/credit-liability.integration.test.ts`; tenant round-trip carries nonzero `includedCents`, guarded against schema drift | Total value and classification both asserted; schema/export tests are not a production migration rehearsal |

## Security dispositions

| Alert | Candidate disposition | Evidence / negative controls |
| --- | --- | --- |
| PR #387 | Corrected in this batch: independent Node SHA-256 fixture; no `bash -c` sealing helper | Real restore script still runs; valid, wrong-candidate, corrupt, incomplete, and unchanged-fleet controls. Require final-head CodeQL instance closure |
| PR #383/#384 | Already corrected scanner implementations on candidate | `tasks/org-billing-codeql-scanners-epic.md`, scanner suites: standalone aliases, dollar names, properties/keys/longer names, regular directory entries. No waiver of production authority |
| PR #385 | Existing dismissal preserved | Unconditional auth; supplied `driveId` passes credential-aware access before org policy reads; omission reads no org. `apps/web/src/app/api/ai/models/__tests__/route.test.ts`; recorded PR thread `discussion_r4260860292` |
| PR #386 | Existing dismissal preserved | Unconditional auth; omitted `drive_id` stores null context; supplied IDs pass scope and membership before creation. `apps/web/src/app/api/messages/conversations/__tests__/route.test.ts`; thread `discussion_r4260860582` |
| Master #231/#232/#233/#234 | Reported guards validate optional tool input, after unconditional authentication/authorization; a body field does not waive authority. Separately, root-agent creation lacked credential-aware drive access; corrected here | Three config/create route suites retain unauthorized/scoped-token refusals and tool validation. Root creation now checks centralized `getUserDriveAccess` for omitted/empty/selected tool variants before writes. No new dismissal performed |
| Master #326 | Already fixed on candidate: linear trailing-slash scan replaces backtracking regex | `packages/lib/src/env-bridge/__tests__/confine-path.test.ts`, including path-boundary/traversal/symlink/read-error controls |
| Master #256 | Already fixed on candidate: deny JavaScript/VBScript and non-raster data schemes | `packages/lib/src/publish/__tests__/sanitize-document-html.test.ts`, including obfuscation and benign raster controls |
| Master #252/#204 | Outside authorization/billing/cutover scope: canvas rendering | Remain open; no clearance or dismissal claimed |
| Master #334/#335/#336 | Outside this release scope: editor Markdown serialization | Remain open; no clearance or dismissal claimed |

A successful security workflow alone is not an acceptance verdict. Retain dismissal comments and source/negative
controls independently of CodeQL's status. The separate root-agent credential-policy correction and policy/seat
lock repair are substantive findings discovered during verification, not relabelings of optional-tool validation.

## Verification commands

Use a disposable restored PostgreSQL **cluster**, with separate main and scratch-admin DBs. Admin erasure tests
create/drop cluster-global roles; a separate database on a shared cluster is insufficient isolation.
Set `DATABASE_URL`, `ADMIN_DATABASE_URL`, `TZ=UTC`, and the test-only security secrets outside this repository.
The private test-mode credential file is `~/.config/pagespace/billing-cutover-20261014/test-runtime.env`.

```sh
# Run from the indicated package directory; no reporter from a different SHA is final evidence.
# packages/lib:
bun run test:coverage -- --reporter=default --reporter=json --outputFile.json=test-results/vitest-results.json
bun run test:integration -- --reporter=default --reporter=json --outputFile.json=test-results/vitest-integration-results.json
# scripts:
bunx vitest run --reporter=default --reporter=json --outputFile.json=test-results/vitest-results.json
# apps/web (test Stripe credential loaded securely; NEXT_PUBLIC_STRIPE_MODE=test):
bunx vitest run src/lib/org-billing/__tests__/org-subscription.stripe.integration.test.ts src/app/api/stripe/webhook/__tests__/org-webhook.stripe.integration.test.ts --no-file-parallelism
# scripts (same TEST credential):
bunx vitest run __tests__/personal-gift-transition.stripe.integration.test.ts
# apps/e2e (isolated production web+Imago, same-origin proxy+Socket.IO, local AI mock):
bunx playwright test tests/33-org-spend-surfaces.spec.ts tests/37-imago-org-wallet-cutover.spec.ts --grep JOURNEYS-
# repo root:
bun run test:infra
bun run typecheck
bun run lint
bun run lint:scripts
bun run typecheck:scripts
bun run scripts/check-spec-coverage.ts --offline
```

The last command must consume complete passing reporter artifacts from the final candidate's hosted CI;
source declarations, a partial fixture title, and prior-head reporters do not supply 87/87 evidence.
The baseline run `38610487083` failed export column drift and therefore skipped later integration reporters;
its 82/87 is incomplete, not proof that five criteria have been implemented incompletely or may be waived.
