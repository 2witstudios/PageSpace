# IMG-20.1 verification and continuation

This is a provisional branch candidate, not completed delivery or independent
acceptance. The exact committed candidate and live CI results are recorded in
its PR and PageSpace handoff. Task remains In Progress while final gates and
interaction checks are unresolved. No merge or deployment is authorized here.

## Environment and evidence

The local functional checks used an isolated PostgreSQL 17 database, migrated
with the existing migrations, and production web/Imago builds behind the
same-origin E2E proxy with realtime, mock OpenRouter and mock S3. Imago was
enabled only in that test runtime. Native wrappers and owner Android files were
untouched. Runtime credentials are not included in this record.

`reuse-source-manifest.json` records the classic source closure and master base;
`reuse-inventory.md` maps features to native routes and maintained boundaries.
`evidence/*.png` are interim local captures, not exact-final-SHA visual approval.
CI uploads fresh reuse screenshots as `imago-reuse-evidence`.

## Checks already observed

| Check | Observed result | Limit |
| --- | --- | --- |
| Imago unit/coverage | 222 files, 1,551 tests passed; 94.38% lines/statements, 94.68% branches, 90.69% functions | Pre-final-edit worktree; final CI rerun required |
| Retained navigation/open-page/file/socket tests | 16 tests passed | Final caret/accessibility additions await CI |
| CSP/image-dispatch focused tests | 32 tests passed | Strict scripts, bounded storage and deployment frame gates |
| Shared context-window/preview-header tests | 95 tests passed | Preview COEP header passed pure test; browser still pending |
| Knip ratchet | Pass, unchanged four-issue baseline | Three existing public lib module entries declared; no ratchet baseline change |
| Workspace typecheck | Earlier candidate passed 23 tasks | Latest run raced Next build deleting `.next/types`; repeat sequentially in CI |
| Workspace lint | Earlier candidate passed 20 tasks | Latest run stopped at owner request; Imago reported 0 errors, 8 inherited warnings |
| Workspace build | Earlier Imago/web and shared-package builds passed individually | Latest whole-workspace build stopped at owner request; no final pass claim |

The full copied-source coverage audit failed the Imago floors before ownership
was separated: 15.98% lines/statements, 86.64% branches, 39.60% functions.
The unchanged floors now cover all native Imago code and every new boundary
adapter. Copied classic tests still run, while original-source coverage belongs
to web. This deliberate policy and its limitations are documented in the inventory.

## Real interactions already observed

The real API/browser checks passed document palette creation, toolbar editing,
saved content reload and history; pending/read-only document/canvas/sheet
permissions; native typed views/settings; actual cross-drive citation navigation
with one shell/chat; rich text chat and persistent drafts; uploaded PNG in its
specialized viewer; original code and sheet writes/reload; native agent-session
creation; channel send/edit/quote/thread/reaction; queued text dispatch after a
held stream; task creation/completion; DM creation/send/edit; sharing a real view
permission on an ordinary drive; and ask_user → answer → backend continuation
with persisted answer reload. Individual runs and screenshots are interim proof,
not a claimed passing final aggregate suite.

Image parts were sent through the real upload/message pipeline, persisted and
rendered, and unsent attachments survived native navigation. Model completion on
local-IP S3 is refused by the SDK's existing SSRF guard. The test asserts the
parts and transport boundary; it does not bypass that guard or claim successful
model image completion.

## Remaining obligations — builder owned

1. Let GitHub Actions run build/typecheck/lint/unit/integration/E2E/image gates.
   Do not resume resource-heavy builds locally: owner explicitly requested CI.
2. Verify the saved canvas iframe after adding the matching COEP header. Saved
   HTML was confirmed in the real preview response, but Chromium refused the
   opaque iframe without that header. Both CSP sandboxes and permissions remain
   unchanged; no `allow-same-origin` was added.
3. Verify new approval-card reconstruction and real API refusal test. The local
   credential plane is not configured; a 503 must remain an actionable failure,
   not a false success. Successful approval issuance needs a configured authority
   and is not claimed by this fixture.
4. Recheck native caret restoration, stream/Stop/history behaviors and updated
   account/settings assertions against the full port. Current fixture selectors
   follow retained accessible controls; no assertions were disabled.
5. Review fresh light/dark screenshots. The dark editor capture now waits for the
   existing color transition to finish before taking evidence. Linux visual
   baselines may need a reviewed update for the intentionally ported controls;
   never regenerate/accept them without inspecting the differences.
6. Resolve any CI failures, publish exact-head evidence and request independent
   review. Only then move the delivered candidate to In Review; never self-Done.

## Reproduction

Use the existing Test Suite PR workflow. It runs the production same-origin
stack and now includes `apps/e2e/tests/36-imago-reuse.spec.ts`, with public
Monaco/PDF assets copied into its standalone Imago server. `Imago Image` proves
the Docker build and boot. The new Docker deployment-mode argument defaults to
cloud exactly as before; Compose passes its configured mode.

Lightweight local source inspection and edits remain available. Local build,
lint and test-service processes were stopped after the owner reported machine
pressure. Private test environment files are excluded from delivery artifacts.
