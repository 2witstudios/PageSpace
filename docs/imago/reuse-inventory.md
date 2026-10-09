# IMG-20.1 source-to-port inventory

Base: `master` at `0b508a34550e03a16104d50cef0e68789239e6fb`.
Task: https://pagespace.ai/dashboard/omziyxp4skckh7ixi2sxzhuk/t2xqwgo8lvaiy7tw64mmzm6l
Prompt: https://pagespace.ai/dashboard/omziyxp4skckh7ixi2sxzhuk/ovvk8mlw8kex4uz9qgvypmnl
Delivery log: https://pagespace.ai/dashboard/omziyxp4skckh7ixi2sxzhuk/jhc9sinhlno4l9b99re1ijk4

Classic paths below are relative to `apps/web/src`. The retained copy is under
`apps/imago/src/retained` at the same relative path. The machine-readable closure,
including roots and source commit, is `reuse-source-manifest.json`. The copy script
preserves maintained adapter edits and inventories imports; it does not mount the
classic dashboard. Current master remains the PR target.

| Feature | Existing source reused | Native Imago entry / boundary |
| --- | --- | --- |
| Document + toolbar + source mode | `components/layout/middle-content/page-views/document`, `components/editors` | `/:drive/files/:page`; permission-filtered `PageObject`, retained document editing-session/SWR guards |
| Code + Monaco | `components/layout/middle-content/page-views/code` | Same object dispatcher; workers copied with the Imago asset prefix |
| Sheet cells, formula, formats, rules, tabs | `components/layout/middle-content/page-views/sheet` | Same dispatcher; original sheet hooks/API writes |
| Canvas preview + editor/settings | `components/layout/middle-content/page-views/canvas`, `components/canvas` | Same dispatcher; original sandbox/rendering; editing fails closed while permissions load |
| File specialized viewers | `components/layout/middle-content/page-views/file` | Same dispatcher; original PDF/image/media/text viewers; PDF worker copied locally |
| Channel send/edit/quote/thread/reactions/files | `components/layout/middle-content/page-views/channel`, `components/messages`, `components/shared/MessageHoverToolbar` | `/:drive/messages/:page` and typed files dispatch |
| DM destinations and conversations | `app/dashboard/dms` | `/dm/new`, `/dm/:conversation`; source conversation controls within retained surfaces |
| Task lists, statuses, detail/configuration and triggers | `components/layout/middle-content/page-views/task-list`, `components/tasks`, `components/agent-triggers` | `/:drive/tasks/:list`, typed files dispatch; individual task route retains Imago detail |
| Workflows | `app/dashboard/[driveId]/workflows`, `components/workflows` | `/:drive/workflows`, rail overflow |
| Creation and uploads | `components/create/QuickCreatePalette`, `components/layout/left-sidebar/PageTree`, `hooks/useFileDrop`, `lib/upload` | Files New page; Messages/Tasks Create page; palette all classic page types and uploads |
| Tree operations and contextual lifecycle | `components/layout/left-sidebar/PageTree`, `components/layout/middle-content/content-header` | Files tree and object header; original move/copy/rename/trash/publish actions |
| Sharing and permissions | `components/layout/middle-content/content-header/page-settings` | Object header dialogs; existing centralized permission APIs |
| History / rollback | `components/layout/right-sidebar/ai-assistant/SidebarActivityTab`, `components/activity` | Object History dialog; drive/user Activity routes |
| Rich chat input, attachments, queue and recovery | `components/agents/chat/SessionChat`, `components/ai/chat/input`, `lib/ai/shared`, streaming stores | Single `ChatPane` content host; shared draft and streaming bridge; original parts/transport |
| Rich results, questions and approvals | `components/ai/shared/chat/MessageRenderer`, `tool-calls`, `ask-user` | Original result registry and interactive answer/approval handlers inside the single host |
| Open page / cross-drive references | `hooks/usePageNavigation`, `lib/ai/shared/hooks/useOpenPagePane` | Page IDs resolve their authorized actual drive; `imagoHref` maps source routes; page-pane tool navigates the native object slot |
| Agent page configuration | `components/ai/page-agents/PageAgentSettingsTab` | AI_CHAT object configuration + Chat action; save only after editable permission |
| Agent sessions/environments/terminals | `components/agents/AgentsSurface` | `/:drive/agents`, `/account/agents`; source PaneChat becomes a selector for the one shell chat |
| Account and integrations | `app/settings`, `app/dashboard/connections`, `components/settings` | `/account/*`; original on-prem/billing/native gates preserved; Storage redirects to unified Usage |
| Drive configuration and roster | `app/dashboard/[driveId]/settings`, `members`, `components/settings/RoleEditor` | `/:drive/settings/*`, `/:drive/members/*` |
| Calendar, activity and trash | Original drive/user routes and corresponding components | Native rail overflow and `/account/{calendar,activity,trash}` |

## Maintained adapters

- Navigation reversibly maps classic path grammar to Imago. Query strings/fragments
  remain intact. The `/p/:page` resolver reads the permission-filtered page before
  selecting its actual drive. All new stage routes retain the server auth gate.
- Retained sockets obtain the existing Imago browser connection. The root remains
  its owner. The classic dashboard and GlobalChatProvider are not mounted.
- One RetainedChat selects either a page agent or an agent-session assistant.
  Agents workspace panes select this host instead of rendering additional chats.
  SessionChat's unsent text lives in the shell store across native navigation.
- Retained surfaces and Radix portal containers use scoped compatibility CSS.
  Shell token rules remain enforced; the compatibility source is explicitly
  scanned and scoped. Styles are generated from classic CSS, including TipTap
  and typography, rather than approximating copied classes.
- UI-only API declarations and tool names are generated from classic source;
  server executors are excluded from the copied closure. The model context-window
  table was moved to a pure shared module with its original exports preserved.
- Copied document/code/canvas and agent settings fail closed until edit permission
  is resolved. Original API authority checks continue to apply to every write.

## Static inventory checks

Knip continues to check copied modules and dependencies for reachability. It
ignores only unused **exports/types** within the retained copy and generated API
declarations: these preserve the original subsystem interfaces for source
maintenance. It does not ignore unused files or dependencies. Generated scoped
CSS are explicit entries; the public PDF worker is an explicitly ignored generated asset because runtime/static asset
consumers are invisible to TypeScript import tracing. Server barrels and unused
classic sidebar shells were removed from the closure.

## Scope constraints

Classic app, database/schema/model behavior, native wrappers and production
Imago defaults are preserved. No migrations or production environment changes.
A local isolated database and test-only runtime flag support browser verification.
No merge, deploy or self-granted Done; an independent reviewer must decide Done.

## Boundary verification details

- The root provider restores classic's authorized drive roster and current-drive
  selection without copying its layout. The native Agents route includes the
  original session directory and creation controls, with shell chrome removed.
- Specialized file dispatch reads MIME/name metadata from the existing authorized
  tree projection, matching classic. The generic page DTO is unchanged.
- Multiple retained auth consumers share the initial OAuth refresh promise. The
  deliberate forced-refresh behavior remains available in the auth store.
- Direct uploads admit only the configured storage endpoint and exact bucket
  host in Imago's CSP. Script nonces/strict-dynamic remain enforced. Stripe and
  development preview hosts follow the existing deployment/feature gates.
- Imago's Docker build accepts the existing public deployment-mode flag. Compose
  supplies its configured mode; an unset value still selects cloud. No production
  default is flipped, and runtime flags do not pretend to override client builds.
- Canvas preview responses now carry the dashboard's COEP `credentialless`
  policy. Chromium otherwise blocks their response-sandboxed opaque document.
  Both original CSP sandboxes retain exactly their previous tokens, without
  `allow-same-origin`; permissions, preview content and CSP fetch directives are
  unchanged. This is an embedding header correction, not a rendering/API redesign.
- Knip's library entries include the three already-exported env-bridge/drive-env
  public modules newly reached by the retained closure. The four-issue baseline
  stays unchanged; a master archive also passes that baseline.

## Coverage ownership

The original Imago thresholds (82% lines/statements, 93% branches, 85% functions)
continue to apply to native Imago **and every new boundary adapter**. The
provenance-locked classic copy is excluded from this denominator; its copied
unit tests still execute in the same run, and its source coverage remains owned
by `apps/web`. This prevents importing a large existing UI from misrepresenting
new Imago code coverage. It does not hide adapters or reduce any threshold.

An initial all-source audit measured 15.98% lines/statements, 86.64% branches and
39.60% functions, including the mostly uninstrumented classic UI. After making
ownership explicit, the native/adapters run measured 94.38% lines/statements,
94.68% branches and 90.69% functions, with 1,551 passing tests. These are interim
worktree measurements; final checks and limitations belong in `verification.md`
and the exact-candidate PageSpace handoff. Browser tests exercise original API
writes, permission races, stream continuation and persisted parts; copied UI is
not claimed fully covered merely because the native gate passes.

## Retained accessibility and task navigation adaptations

The retained page tree names its navigation and announces the current page.
Channel/DM message rows are articles with pending state, inside named conversation
regions. Kanban cards, drag handles, columns and task status/priority selectors
have accessible names. These adapt the existing controls, not their API behavior.
Task-list title navigation opens the existing native Tasks detail route; generic
citations still resolve through the permission-filtered object route.

Native cloud billing and plan pages mirror classic's exact COEP exception needed
by Stripe; all other native pages retain credentialless COEP. CSP script nonce,
strict-dynamic, deployment gating and frame-ancestor protections are unchanged.


Embedded subscription payment confirmation returns to the native `/imago/account/plan`
using Imago’s existing validated return-path helper. Stripe-hosted payment-method
portal and credit top-up sessions keep the existing server-selected classic return
URLs; those external billing service contracts are preserved, not redesigned by
this UI port. Both settings surfaces themselves are available natively and keep
cloud/on-prem deployment gates. Live Stripe payment issuance requires its existing
configured service and is not claimed by the local/cloud-mock interaction fixture.

The retained rich editor subscribes its character counter to TipTap editor state,
including content hydration transactions. This avoids a stale zero beside loaded
content without changing serialization, save transport or editing permissions.

Retained explicit SWR mutations use the enclosing Imago cache rather than SWR’s
unrelated global cache. Retained task hydration/edits also refresh the native task
projection used by list progress and individual details. Filtering reveals matching
descendants and their ancestors without changing saved tree expansion. Task-list
navigation loads its authenticated route on demand instead of prefetching it.
