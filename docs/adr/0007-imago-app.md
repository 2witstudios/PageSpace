# ADR 0007 — Imago: a separate app over the existing platform

- **Status:** Accepted (plan approved by Jonathan Woodall, 2026-10-04)
- **Date:** 2026-10-04
- **Deciders:** Imago epic (plan page `i8mztmt39q5urnaw7y7aket4`, "Plan — Imago"; task IMG-1.1 `fqi53f9pi68ierlxfnazi2kg`), owner decisions D1–D6 of the decision record "Plan: Imago Rewrite — Architecture, Scope & Decisions" (`cvcgrh9zw4le485vo9foq540`), and the plan's DEC-1..DEC-12 defaults as approved.
- **Related:** design source — myimago ADR 0029 "the Imago interface shell" (`~/Projects/myimago/docs/decisions/0029-imago-shell.md` on `feat/imago-shell-live`, SHELL-1..10). House style: ADR 0003.
- **Frozen surface:** `apps/imago` as its own Next app at `basePath: '/imago'`, same-origin with `apps/web`; no new auth; built-in Imago agents as `AI_CHAT` pages in the Home drive on the page-chat pipeline; `agent_workspaces.driveId` always set; leaf PRs integrate on `pu/imago`.

## Question

Imago is the designed replacement for PageSpace's UI: one rail, a pane that holds a collection, the object you opened, and one continuous chat bound to that object. Today's UI has two chat hosts (the dashboard's `GlobalAssistantView` and the right sidebar), a global level beside drives, and a three-panel layout that remounts between sections. A working shell exists on mock data in myimago. How does it come into this monorepo, and what must the backend change for Imago's model to hold?

## Decision (summary)

**Imago ships as a new `apps/imago` Next app in this monorepo, over the existing API, data and sign-in, beside classic and behind a flag (D6: rewrite the app layer, keep the platform).** It is served same-origin at `/imago`, authenticates with the shared `session` cookie, and ports myimago's token-locked design system. The backend changes Imago's model requires land in the same run: the built-in Imago agents become ordinary `AI_CHAT` agents in each user's Home drive running on `runPageChatTurn`, and agent workspaces become drive-scoped. Every leaf PR integrates on `pu/imago`; only the owner merges `pu/imago` → master.

---

## 1. Owner decisions this ADR rests on

From the decision record (2026-09-20 … 2026-09-29):

| # | Decision |
|---|---|
| D1 | The brand keeps the existing blue `--primary` (`oklch(0.50 0.16 235)`); the violet→cyan gradient is retired. |
| D2 | "Imago" is the assistant family. The chat-header selector picks an **agent**, not a model: Imago Planner, Imago Researcher, plus the user's own `AI_CHAT` agents. (Planner and Researcher retired by the owner on 2026-10-06 — see §5.) |
| D3 | Chat replaces Home as a rail destination. |
| D4 | No global/dashboard level. Everything is drive-scoped; there is a Home drive. |
| D5 | A `⋯` overflow in the rail below Plugins holds Workflows, Activity, Connections and similar. (Departed from by DEC-6, §6.) |
| D6 | Rewrite the app layer, not the platform; web + native rather than web only. |

Plus the owner's 2026-10-04 decisions recorded on the plan: Imago is a new `apps/imago` app over the existing API (D6), not a restyle of `apps/web`; and this run includes the backend — Imago agents in Home (replacing the global assistant for Imago), the Home-drive backfill, and drive-scoping `agent_workspaces`.

## 2. Decision D-A — a separate, same-origin app

- `apps/imago` is its own workspace (Next 15, React 19, matching `apps/web`), with `basePath: '/imago'` and `output: 'standalone'`. In production it is served same-origin at `pagespace.ai/imago`; in dev it runs on `:3006`.
- **Dev proxies `/api/*` to `apps/web`.** `next dev` rewrites `/api/:path*` (with `basePath: false`) to `WEB_APP_INTERNAL_URL`, so the browser only ever talks to one origin and cookies and CSRF behave exactly as in production. The imago origin joins `ADDITIONAL_ALLOWED_ORIGINS` for web origin validation and for realtime.
- **Data goes through the existing routes.** One fetch client (same-origin credentials + `X-CSRF-Token`) and SWR, with types from `@pagespace/lib/client-safe`. Only two routes are added for imago: the viewer's built-in agent pointers (`GET /api/user/builtin-agents`) and the per-drive Imago access toggle (`/api/drives/[driveId]/imago-access`). Imago never calls `/api/ai/global/*`.
- **Realtime** connects with a `ps_sock_` token from `/api/auth/socket-token`.
- **Classic keeps working throughout.** Imago is additive behind `IMAGO_ENABLED` / `NEXT_PUBLIC_IMAGO_ENABLED` (env only, DEC-10; no per-user preference). The only `apps/web` edits are the sign-in allow-list, a "Try Imago" link and the backend changes in §4–§5. The flag is the only gate: onprem behaves like cloud and tenant.

Why not a restyle of `apps/web`: the decision record (§4, §6) finds that what Imago removes — the second chat host, the right panel's modes, the all-drives layer — is the product model encoded in the app layer, while `packages/lib` encodes hard-won correctness. *Rewrite what encodes the old product model; keep what encodes correctness.*

## 3. Decision D-B — no new auth

- Middleware checks for the shared `session` cookie; with none, it redirects to classic's `/auth/signin?next=/imago/<path>`. The `/imago` prefix is added to classic's sign-in `next` allow-list, which still rejects protocol-relative, absolute and backslash-smuggled URLs.
- Server components validate the cookie with `@pagespace/lib` session-service (`packages/lib/src/auth/session-service.ts`, `validateSession(token, { expectedType: 'user' })`) and send invalid or revoked sessions to sign-in.
- Sign-out calls the web logout endpoint. No token type, session store or permission path is added.

## 4. Decision D-C — the design system is ported, token-locked

The design source is myimago ADR 0029 on `feat/imago-shell-live`; this ADR cites it rather than restating it. What carries over:

- Token-locked Tailwind 4: every default namespace reset, only named tokens defined, and ESLint (`better-tailwindcss`) failing on arbitrary values, `dark:` variants and unknown classes; a theme test fails if a numbered or default token name reappears.
- PageSpace's neutrals and the D1 blue accent via `light-dark()`, the glass materials, the radius ladder (6/8/10/14, composer 16), 14px Geist, frame metrics (rail 64, pane header 52, list 274, tree 244, chat 350) and one motion curve (`--ease-pane`, 320ms; zeroed under reduced motion).
- The container/render split with `*-class.ts` modules tested by exact-string RITEway assertions (run under vitest), and the in-house `useSyncExternalStore` store with pure transactions.
- One `(shell)` layout that never remounts; the stage is derived from the drive-scoped URL by a pure `stageFor(pathname)`; panes are always mounted and animate width.

One deliberate difference from myimago: icons are `lucide-react` at stroke 1.5 / 16px instead of myimago's hand-drawn set, so PageSpace's page-type icons are covered (DEC-8).

## 5. Decision D-D — built-in Imago agents live in the Home drive

- A `user_builtin_agents(userId, key, pageId)` pointer table and a pure registry define the built-in agent. Since the owner decision of 2026-10-06 (IMG-10.10) there is **one, `imago`**: it replaces the global assistant one for one. The earlier `imago-planner` and `imago-researcher` are retired — provisioning trashes their pages and drops their pointers. Imago is provisioned as an `AI_CHAT` page in the user's Home drive by `provisionHomeDriveIfNeeded` (`packages/lib/src/onboarding/home-drive.ts`) and backfilled for existing users, Home drive first.
- It runs on the page-chat pipeline (`runPageChatTurn`, `apps/web/src/lib/ai/chat-pipeline/page-chat-turn.ts`), and for its owner that turn hands it the **global assistant's tool set and context through shared code** (`apps/web/src/lib/ai/chat-pipeline/assistant-surface.ts`, run by `runGlobalChatTurn` too): the full tool registry under the same filters (sandbox tier, agent-account tools, read-only, web search, image generation), the user's and the in-view drive's integrations through the one assistant resolver (still gated by `isOnPrem()`), desktop MCP, `finish`/`ask_user`, and the same location, Home-drive hint, drive prompt, drive tree or all-drives summary, personalization and agent awareness — plus a short Imago persona and its Agent Memory. An owner's Imago conversation gets a sandbox session in their Home drive on first use, as the global assistant's gets a driveless one.
- **Reach is the user's** (superseding DEC-2's grant model). The Imago page carries `pages.userScopedAccess`, and `apps/web/src/lib/ai/tools/actor-permissions.ts` resolves it as the invoking user's own access — every drive, member-only drives, shared and private pages, delete — exactly like the global assistant, but **only when the invoking user is the agent's owner**. Run by anyone else (consult, @mention, workflows, `ask_agent`, a page chat on a shared page) it reaches nothing and its turn gets no tools. No `drive_agent_members` grants are made for it; the ones the earlier model made are removed on sign-in and by the backfill.
- **The per-drive setting is an exclusion.** `imago_drive_access` off keeps the user's Imago out of that drive even though the user can open it — its pages, search results (including cross-drive), tree, activity, drive-level integrations, commands and sessions there — enforced centrally in `actor-permissions.ts` and the shared context builder. It defaults to on in every drive the user can access, any user who can access a drive sets only their own choice there, the user's own Home drive is refused, and an off stored by the earlier model keeps its meaning.
- The model is a per-agent setting; Imago's composer has no model picker (DEC-5).

This is what makes the second chat strategy unnecessary for Imago: a built-in agent is an ordinary `AI_CHAT` page that, for its owner, assembles the global assistant's surface from the same code.

## 6. Decision D-E — agent workspaces become drive-scoped

`agent_workspaces.driveId` is null today for global-assistant sessions, and every layer branches on it (decision record §3). Moving those sessions into the owner's Home drive preserves behaviour exactly: the Home drive cannot be shared, invited to, published or transferred (`packages/lib/src/services/drive-guards.ts`), so drive access *is* owner-only; the Sprite name is an HMAC over (tenant, session id) and the Home drive's owner is the same user, so tenant, Sprite, filesystem and payer are unchanged.

Sequence (the two-release rule, precedent 0249–0251):

1. New assistant sessions get the owner's Home drive.
2. A re-runnable custom data migration backfills nulls and adds `CHECK ("driveId" IS NOT NULL) NOT VALID`; it raises rather than skips when an owner has no Home drive.
3. After a production release confirms zero nulls, a second migration validates the check and makes the column `NOT NULL`.
4. The null-drive branches across lib, billing, sandbox storage, realtime, AI tools and routes are deleted.

## 7. Decision D-F — the integration branch

Every leaf PR targets `pu/imago` (DEC-1). The orchestrator merges a leaf into `pu/imago` once an APPROVE review record exists for its head SHA and CI is green; only the owner merges `pu/imago` → master — mid-run for the production backfills (IMG-4.4, IMG-5.3) and at sign-off (IMG-11.2). Why: one uninterrupted run without unreviewed code reaching master.

## 8. DEC-6 departs from D5

D5 puts the `⋯` overflow on the rail **below Plugins**. DEC-6 changes that for this epic:

- The rail is Chat, Files, Messages (channels + DMs), Tasks, Settings.
- **Plugins is not on the rail this epic** (neither Plugins nor Console is built), so the `⋯` overflow sits **below Tasks**.
- The overflow holds Calendar, Agents, Connections, Activity and Trash as deep links into classic for the current drive.

D5's intent — secondary destinations behind one overflow — stands; only its anchor moves. Whether Plugins returns to the rail, and what separates Plugins from Connections (both are `integration_connections` in production), stays open (§10).

## 9. What this ADR defers

- **Global pipeline deletion** — `global-chat-turn.ts`, `/api/ai/global/*`, the `'global'` conversation type and `global_assistant_config` stay, because classic and the frozen desktop/mobile/MCP/CLI wire contract still use them (DEC-3). Imago never calls them; deletion moves to a cutover epic.
- **Classic's driveless layer** — `/dashboard/*` driveless routes, `lib/dashboard/focus.ts` and the `context: 'user'` aggregate APIs are retired at cutover, not edited now. Imago has no aggregate "my tasks across drives" view (DEC-11, per D4).
- **Unified messaging tables** — new drive-scoped tables for one messaging model, triggers and preferences (decision record §7) belong to a separate data-model epic.
- **Native clients** — SwiftUI clients and a generated cross-platform token source (decision record §8).
- **Mobile** — Imago is desktop-first; native wrappers keep loading `/dashboard` (DEC-4).
- **Surfaces** — Imago object views for sheets, canvases, code and files open in classic from an object card (DEC-9); Calendar, Console and Plugins surfaces (DEC-6); composer @-mentions, /-commands, attachments and dictation (DEC-7); collaborative (yjs) document editing.
- **Production infra** in PageSpace-Deploy beyond routing `/imago` to the imago service.

## 10. Open questions (not decided here)

From the decision record, still open:

- Which renames of shipped surfaces stand (workspace/drive, Messages/(Channels + DMs), Console/Agents, Plugins/Connections).
- Plugins vs Connections: what separates them, and whether Plugins returns to the rail.
- The design system's internal codename, now that "Imago" is the assistant.

## 11. Consequences

- The monorepo gains a new service (`apps/imago`, port 3006, its own Docker image and CI matrix entry); production routes `/imago*` to it ahead of `apps/web`.
- `apps/web` stays the API and the classic UI; imago is a client of its routes. Two routes are added; no route is removed.
- Every user gains one `AI_CHAT` page (Imago) in their Home drive and a pointer row in `user_builtin_agents`; it is a member of the Home drive only, and reaches every other drive through the user.
- `agent_workspaces.driveId` becomes `NOT NULL` after two releases, and the global-assistant branches in access, billing, storage, realtime and tools are deleted.
- The global chat pipeline remains in service for classic and the wire contract until the cutover epic.
