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

## Remote candidate checks and follow-up

Candidate `b26d718132718eb4889a524ce7bec17da148c616` is published as draft
[PR #2860](https://github.com/2witstudios/PageSpace/pull/2860), against master.
The owner requested GitHub Actions for resource-heavy verification; all owned
local build, lint, app/proxy/realtime processes and the isolated database were
stopped. Do not restart them for the final gates.

- Test Suite run `37964494078`: workspace lint/typecheck passed. Unit and browser
  jobs were still running when the next candidate was prepared; no pass inferred.
- Imago Image run `37964493750`: image build and boot passed for `b26d718`.
- Security run `37964493752`: all workflow jobs passed. The separate CodeQL alert
  check identified two test-assertion patterns and the copied OAuth-grant row-id
  storage. The assertions now check exact CSP tokens and extract text without
  pretending to sanitize HTML. Alert #358 was dismissed with source evidence as
  the exact same false positive as previously dismissed classic alert #250:
  only a grant row id is stored, never an OAuth credential or step-up token.
- Connected PageSpace tools returned `Transport closed` during handoff publication.
  No new page id is claimed; the durable local record is available for orchestrator
  reconciliation. The task remains In Progress.

The follow-up candidate mirrors classic's exact cloud billing/plan COEP exception,
adds accessible tree selection/message/task names, and updates existing browser
specs 29/32/33/34 to the retained controls while preserving their real writes,
reloads, live two-person delivery, pointer drag, rollback and subtask guard checks.
Task-context navigation stays in the native Tasks section and its existing detail.
The wide task-table regression uses a wider frame; spec 36 covers compact controls.
Linux visual baselines still require deliberate remote regeneration and inspection.


Follow-up `97f7ff78c8a78953f1881ab09c211e5eb7490754` failed remote Imago
build/typecheck because the new channel label referenced a title omitted from
its minimal UI prop type. Corrected by declaring an optional UI title supplied
by the existing authorized page data, with an unnamed-data fallback. This does
not change any backend DTO. The next candidate also adds a real status-category
and disabled scheduled-workflow creation/reload check to spec 36. Neither these
new actions nor the previous candidate’s remaining gates are claimed passed.


Source investigation found that the explicitly selected GPT-4o Mini in the chat
and visual fixtures is outside master’s free-model allowlist. This explains why
interim tenant interaction runs worked while cloud CI reached no mock stream.
Fixtures now use `DEFAULT_AI_PROVIDER`/`DEFAULT_AI_MODEL` from the existing shared
catalog, preserving production model choices, billing policy and all backend gates.
The original streaming spec also awaits the real chat admission response and the
retained loading/composer readiness, rather than an obsolete native `<ol>` marker.
No response body, runtime credential or environment material is logged.

The cancelled first candidate’s completed Imago unit phase passed 1,551 tests in
222 files. Its uploaded coverage summary measured 94.36% lines/statements,
94.64% branches and 90.69% functions. This is exact `b26d718` intermediate evidence,
not a passing aggregate job or a substitute for the final candidate’s CI.

### Cloud follow-up at `75bcc336596831465ebc39d99811da3ecc58784b`

GitHub Actions passed production web/Imago builds, workspace lint/typecheck/Knip,
the Imago image build/boot and security jobs. The aggregate coverage and full
browser jobs remain pending. No heavy local build or test process remains running
after the owner requested cloud verification.

Manual Linux visual generation (run `37969460678`) passed chat, files, document,
channel, DM and task-board captures in both themes. The task-list case failed
because its wide pane exposes direct filter tabs rather than the compact Filters
sheet. Reviewed the twelve produced images; do not treat this partial run as a
validated baseline set. The next fixture supports both real responsive controls.
Review also caught the document count displaying zero after content hydration:
the retained counter now subscribes to editor state, and capture waits for the
seeded document’s actual 181-character count. A complete generation, repeat
comparison and token negative control are still required before baseline commit.

PageSpace publication still returns `Transport closed`; this record and the PR
carry progress for orchestrator reconciliation. Task status remains In Progress.

The full browser job on this SHA completed with 62 passes and 17 failures.
Eight failures involve old visual baselines; task-list capture also assumes the
compact filter. Functional follow-up covers the palette’s second naming dialog,
auto-expanding filtered tree ancestors, refreshing the native task projection
after retained edits, scoped SWR mutation in retained settings/calendar/chat,
browser-authenticated Secure-cookie probes and the workflow agent selector.
Disabling task-link prefetch did not resolve navigation and is reverted. The next
trace showed concurrent OAuth cleanup replacing browser history with empty state
during navigation. Cleanup now preserves Next router state and is idempotent.
The completion-refusal test holds real GET revalidation to reproduce a stale client
without mocking the outside write or the server’s 422, rollback and storage checks.
These fixes require the next exact-candidate cloud run; they are not claimed passed.

The independent manual run on `75bcc336` completed its aggregate coverage step:
Imago passed 1,552 tests in 222 files; the workspace command failed one web test
(`conversation-events-audience.test.ts` emitter registry), with 21,397 other web
tests passing. Its repo-wide source scan correctly discovered a copied server
conversation emitter, reached solely by type imports. The next change extracts
those exact event payload declarations into the existing generated UI contracts
and removes that server implementation and its unused masking helper from the
retained closure (850 source files). No emitter-registry exception is added.
Processor/integration phases did not run after this failure; they remain required.

### Linux baseline evidence at `ce5a5fbbeac3a948e407d22b8e53604da65dcfd2`

Run `37973401635` passed production builds, lint/typecheck/Knip and its manual
visual job. Generation passed seven cases (fourteen PNGs); repeat comparison and
the token negative control passed, with one board comparison requiring a retry
(2,806 changed pixels). Reviewed all fourteen images. Both document captures show
the correct 181 characters. The task fixture seeds after opening, so capture now
also awaits the persisted sidebar meter (2 of 7 tasks done). Pixel thresholds stay
unchanged. CI now retains successful-run reports too, so any retry differences
remain inspectable. The next normal comparison must validate the committed PNGs.
Image build/boot and security passed at this SHA. The full interaction job completed
with 68 passes and 11 failures: eight visual baseline mismatches, task-list navigation,
the stale-client completion test and nested-dialog workflow navigation. Saved Canvas
content, approval cards and read-only boundaries passed. The next candidate fixes the
three remaining failures and includes the reviewed PNGs. Aggregate coverage still
requires the emitter cleanup and subsequent processor/integration gates.

### Candidate `63bc378e7e01ee53d2b5b6fa111a14c18aaf46dc`

Test Suite `37976738495` is running; security `37976738033` and Imago image
build/boot `37976738051` passed. The web production build passed. Do not infer
final browser, lint/typecheck or aggregate results while those jobs are running.

Prepared follow-up: a real task-trigger save/reload/removal test found that the
open editing form pauses SWR’s bare mutate revalidation. Explicit saves/removals
now fetch canonical trigger data and populate the cache with revalidation false,
without removing the editing pause. This follow-up is not yet validated remotely.
The prior ce5 manual aggregate also finished with the same sole copied-emitter
audit failure (1,552 Imago tests and 21,397 other web tests passed).

### Interaction report at `dc48a0655337a7d19a34a1cbd174eb23d29e738e`

Test Suite `37978368784`: production web/Imago builds and lint/typecheck/Knip
passed. Image `37978368362` and security `37978368376` passed. Browser job
`113982823915` completed with 75 passes, two failures and three retries (8.3m).
Task-list navigation and anchored workflow persistence passed. The held-request
server-422 branch reached its real refusal/rollback assertions, then failed because
unroute resumed the same request as its handler; cleanup now waits for handlers.
The new trigger check right-clicked Editor view, which has no table context menu;
it now selects the existing Table control before opening the menu, including for
the view-only member. Trigger save/reload/removal still needs confirmation.

Two retried document/sharing cases exposed an unguarded character-count storage
read during editor construction. The selector now guards the not-yet-installed
extension; content/181-character readiness assertions stay intact. The task-list
dark diff is a swap of the two pending rows (3,512 pixels), not a style difference.
The fixture supplied insertion indexes to the existing unsorted-peer API path,
which can produce tied stored positions and an ID-based order after reload.
Sequential default append requests give distinct positions; fixtures now assert
the expected table/card ordering before capture. Backend ordering is unchanged.
No screenshot threshold, retry policy or baseline is weakened. Aggregate coverage
is still running on this candidate; no aggregate pass is inferred.

Cloud screenshot review also found the drive-integrations capture occurred while
its body was loading. The follow-up awaits the actual empty-state/Connect controls
and exercises provider selection, the existing configuration dialog and Cancel.
Its OAuth return path now maps at the UI boundary to a basePath-inclusive native
callback, with focused path tests. Backend OAuth and desktop launch bridges are
unchanged; live provider authorization is not claimed.

Reviewed the successful workflow/sharing captures from dc48. The workflow table
exceeded the dialog’s responsive width, so the copied dialog now has an explicit
responsive width and a shrinkable content grid; its action bounds are asserted
in the browser test. Private page links now use the same native browser-path
adapter as OAuth return paths; the real sharing test checks the displayed link
and opens it for the newly granted read-only member. Public publication URLs are
unchanged. Scoped CSS generation completed in under a second; no local app build
was restarted. These follow-ups require the next exact-candidate cloud run.

The dc48 aggregate job completed. Node 24 coverage passed all 19 workspace tasks:
1,552 Imago tests, 21,398 web tests and the repo-wide emitter registry passed.
Processor Node 22 coverage passed (1,220 tests); backfill passed (472); database
integration passed (184); library integration passed (643, 73 pre-existing skips);
Imago integration passed (11); real Infisical suites passed (70, no skipped cases).
The final infrastructure gate failed one of 398 tests: `imago-image.test.ts` found
that `apps/web/src`, newly copied by the image’s contract generator, was absent
from workflow triggers. The follow-up adds that source path to both PR and master
push filters. No infrastructure assertion or existing skip policy is weakened.
This is the aggregate job’s only failure; a complete exact-head rerun is required.

### Candidate `7f61a1ef61932d58c1b262af758ed460ee6785a4`

Test Suite `37983175249` has passed production builds and lint/typecheck/Knip;
full aggregate and browser results are still pending. Image `37983174929` and
security `37983174924` passed. No local build was restarted.

The navigation audit found retained expiry/device-revoke flows could prefix the
public sign-in route with Imago's basePath. The follow-up maps public auth through
Imago's existing configured origin, with focused path cases and a real revoked-
session editor-write browser check. It awaits its own exact-candidate cloud run.

The 7f browser run completed: 79 passes, one trigger-test failure, zero flaky
cases (80 total, 7.8m). All fourteen light/dark baselines and the visual token
negative control passed without retries. Real server-422 refusal/rollback,
sharing/native links, workflow persistence/action containment and integrations
configuration passed. The trigger test selected Table view but the pane remained
under its 700px container breakpoint: classic renders a compact row there, whose
actions live in Task Details rather than a right-click menu. The follow-up uses
that real detail-sheet Triggers button (or the existing row menu in wide panes),
and checks that read-only users lack that action plus receive a real API 403.
No responsive breakpoint, timeout, retry or permission rule changes are needed.

The compact task-sheet audit also found its copied completion/title/status
controls used an optimistic loading answer. Imago now waits for a definite edit
grant. The same real reader scenario holds the permissions response and checks
write controls before and after release, retaining the API's own authorization.

The 7f full aggregate completed successfully: all 19 Node 24 workspace tasks
(1,558 Imago tests; unchanged coverage floors met), processor coverage (1,220),
backfill (472), DB integration (184), lib integration (643 with 73 existing skips),
Imago integration (11), real Infisical (70, zero skips) and infrastructure (398)
passed. The image-trigger correction is confirmed.

External review is now enabled per owner steering: keep the PR ready for review.
Review fixes include public Compose CSP inputs, scoped custom picker portals,
Google Calendar's native callback and the explicit standalone public auth origin.
The new browser picker case selects a real page mention and follows the real
Commands empty-state link inside the persistent shell. Final candidate cloud
results and independently reviewed acceptance will be recorded in the verified
PR/handoff; no pass is inferred from earlier snapshots.

External 7f review identified a session-header mismatch and eager empty-conversation
creation. The follow-up derives the header/picker from retained selection and
defers creation to first send, reusing the empty message area and rich input.
Focused cases cover no-create drafts, first-send handoff/deduplication, refused
creation recovery, read-only guards and once-only initial dispatch. Real browser
cases verify zero rows/POSTs for abandoned drafts, one persisted first turn, and
a custom workspace turn in the returned conversation before selecting Imago.
These new follow-ups await their exact-candidate cloud checks.

The picker fixture accounts for Home's installed personal /plan command: it
selects that real command chip, then removes only its own user's configured
commands and reloads before checking the genuine empty-state settings link.
No search response is fabricated and installed production defaults are unchanged.

### Cloud result at 329aa38 and next fixture corrections

Test Suite [37986452624](https://github.com/2witstudios/PageSpace/actions/runs/37986452624) completed: production builds, lint/typecheck/Knip and all 19 Node 24 workspace tasks passed. Imago: 1,562 tests/222 files, coverage 94.37% lines/statements, 94.66% branches, 90.70% functions. Processor 1,220; backfill 472; DB integration 184; lib integration 643 (73 existing skips); Imago integration 11; real Infisical 70; infrastructure 399 all passed. Image build/boot 37986452251 and Security 37986452263 passed.

Browser: 79 passed, 3 failed, no flaky cases; all 14 normal visual comparisons and negative control passed. Real revoked-session write refusal/sign-in exit passed. Failures were the command-empty-state assumption (real personal /plan is installed), the two-step session palette changing its accessible dialog title to “Name your session”, and a trigger removal assertion expecting deletion instead of the canonical disabled persisted record. Fixtures now select the installed command before exercising empty-state navigation, target the naming dialog by its actual accessible labels, and assert persisted disabled trigger/workflow scheduling metadata. No backend/API semantics or test thresholds changed. The held read-only trigger boundary must still run successfully on the next candidate.

Queued source fixes also cover the independent review's workspace-agent/header mismatch and eager empty conversation creation, with adapter and real first-turn/persistence tests. Explicit document navigation handles public auth exits. These changes await their own exact-head cloud gates and independent delta review.

5a6f8ba6 cloud typecheck found the unsent draft ChatInput missing its required onStop callback. Added the callback; isStreaming is always false before first send, so no Stop control is presented in that state. Source SessionChat owns the real streamed Stop operation. Image attempts hit Docker Hub HTTP 429 during base-image metadata lookup before compilation, first oven/bun then node; fresh candidate CI must recheck compilation and image boot.

The 329 browser trace clarified that mention selection failed before reaching Commands: the inherited SessionChat supplied only commandDriveId, while MentionPicker requires driveId or crossDrive to fetch. Both native unsent drafts and active page-agent chat now supply the agent drive plus the existing cross-drive permission-filtered search option. The server still decides every visible mention. The session transport test asserts that scope, and the real picker case must select its created page. This corrects the earlier fixture-only diagnosis; Commands default handling remains a subsequent required step.

### Delta review and CI registry recovery

Independent Codex review of 5a6f8ba6 added two findings: post-account-deletion hard navigation must use the configured public web origin, and both TipTap mention-popup creation paths must mount under retained-portals. Source now resolves the existing deletion confirmation/Apple marker through the same public-auth helper, and TipTap uses the scoped root with no body fallback. The browser picker flow also inserts and persists an actual editor mention; native public-origin tests include the Apple manual-disconnect query.

d7aa3b98 Test Suite 37989913584 passed lint/typecheck and 82/83 browser cases without flaky cases. Lazy first-send/abandoned-draft DB counts, workspace agent header/real turn/switch-back, and trigger save/reload/disabled-record/read-only boundary all passed. Only mention search failed, fixed by supplying scope in 98d2a45b. Security 37989913129 passed. Unit service initialization and Imago image build were refused by Docker Hub unauthenticated pull limits before test execution/compilation. 98d2a45b repeated the same Docker Hub pull failure for both service jobs and base image. No failed/cancelled unit suite is claimed passing.

CI now pulls the unchanged Postgres service tag from Google's public Docker Hub cache and preloads the unchanged Infisical/Redis/Postgres fixture tags from that cache before the existing Compose bring-up. BuildKit tries the same cache before Docker Hub for image base tags. Production Dockerfiles/Compose image references and application defaults remain unchanged. All six required public manifest tags returned HTTP 200 from mirror.gcr.io without credentials. [Official cache documentation](https://docs.cloud.google.com/artifact-registry/docs/pull-cached-dockerhub-images). Exact-candidate cloud verification remains pending.
