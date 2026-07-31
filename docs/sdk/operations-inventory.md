# pagespace-mcp Operations Inventory (Phase 0 parity contract)

**Status:** ADR / frozen ground truth · **Task:** `m2mcgumjloe1r9tr4xgxmfa4` (Phase 0, epic `ea07mt5jvw0flihsbjce1iv9`)
**Sources of truth:**

- MCP server: `/Users/jono/production/pagespace-mcp` — `package.json` version **5.2.3** (note: `src/server.js:33` still self-reports `5.1.1` in `serverInfo`; treat package.json as canonical).
- Web routes: this monorepo, `apps/web/src/app/api/**` at branch `pu/cli-login` ancestry (master `660528a7a`).

**Method:** every registered tool in `src/tools.js` (1575 lines) was mapped to its handler call site, then every endpoint the handler calls was verified against the real route file. **Routes are truth; handlers are parity intent.** Where they disagree, the row below carries an explicit `DISCREPANCY:` note with a resolution the SDK registry must adopt.

**Tool count: 67 registered tools** (`src/tools.js:1–1575`), all dispatched in `src/server.js:90–327`. There are no hidden tools: the dispatch switch and the `tools` array cover exactly the same 67 names.

**Schema note (verified fact):** `tools.js` declares tool inputs as **plain JSON Schema objects**, not zod. Zod validation exists only server-side in some routes. The SDK operation registry (Phase 2) introduces zod as the single input/output schema source; the "input fields" columns below are the parity contract it must encode.

**Transport (to be replaced):** `src/api.js:12–133` — `PageSpaceApi.request(method, endpoint, data)` / `makeAuthenticatedRequest`. All requests send `Authorization: Bearer <token>` + `Content-Type: application/json`, 30s `AbortController` timeout (`api.js:7`), non-2xx → thrown `Error("API request failed (<status>): <text>")`, success → `response.json()` (except `requestText`, which is currently **unused** by any tool — no export tools are registered).

---

## 1. Authentication ground truth

`apps/web/src/lib/auth/index.ts`:

- `TokenType = 'mcp' | 'session'` (`index.ts:15`). MCP tokens are opaque `mcp_*`, SHA3-256 hashed at rest via `hashToken` (`index.ts:73`, `packages/lib/src/auth/token-utils.ts`). Sessions are opaque `ps_sess_*`.
- `authenticateRequestWithOptions(request, { allow, requireCSRF })` (`index.ts:265`) is the standard route gate. Bearer `mcp_*` on a route that doesn't allow `'mcp'` → **401 `"MCP tokens are not permitted for this endpoint"`** (`index.ts:284–291`). CSRF applies only to cookie-session auth, never Bearer (`index.ts:320–333`).
- Scoped tokens: `allowedDriveIds` non-empty ⇒ every route re-checks scope via `checkMCPDriveScope` / `checkMCPPageScope` (`index.ts:457–519`) → 403 `"This token does not have access to this drive"`. **Fail-closed:** a token flagged `isScoped` whose drive scopes were all deleted authenticates as *invalid* (`index.ts:129–135`), and suspended users get their token revoked on next use (`index.ts:107–122`).
- Scoped tokens act as their **own drive member** (principal permissions, PR #1609/#1745) — not as the owning user — via `getPrincipalAccessLevel` etc. (`index.ts:585–598`, `packages/lib/src/permissions/principal-permissions.ts`).

Every route in the inventory below accepts `allow: ['session','mcp']` **except** where a `DISCREPANCY` row says otherwise (one route is session-only; one route is public/no-auth).

---

## 2. Inventory

Column key — **Tool**: MCP tool name (`tools.js` line of its schema). **Input**: fields as declared in the tool's JSON Schema (`*` = required). **Call**: HTTP method + path the handler sends (handler file:line). **Route**: verified route file (all under `apps/web/src/app/api/`) + exported method line. **Response (route truth)**: the JSON the route actually returns on success.

### 2.1 Drives (4 tools)

| Tool | Input | Call | Route | Response (route truth) |
|---|---|---|---|---|
| `list_drives` (tools.js:4) | — | GET `/api/drives` (drive.js:9) | `drives/route.ts:28` | Bare **array** of `DriveWithAccess` (`{...drive, isOwned, role, lastAccessedAt}`) (`drives/route.ts:74`). Extra query params the tool doesn't expose: `includeTrash`, `tokenScopable` (`drives/route.ts:38–39`). Scoped tokens get their member-drive universe with the TOKEN's role (`drives/route.ts:43–64`). |
| `create_drive` (tools.js:13) | `name*` | POST `/api/drives` (drive.js:53) | `drives/route.ts:81` | `201` bare drive row (`drives/route.ts:131`). Reserved names → 400; scoped tokens → 403 via `checkMCPCreateScope(auth, null)` (`drives/route.ts:88`). |
| `rename_drive` (tools.js:27) | `driveId*`, `name*` | PATCH `/api/drives/{driveId}` (drive.js:88) | `drives/[driveId]/route.ts:99` | Updated drive row (`:230`). Owner/admin only (`:137`); Home drives un-renameable → 403 (`:126`). Route also accepts `aiProvider`, `aiModel`, `drivePrompt` (≤10000), `homePageId`, `publishDefaultOgImageUrl` (`:18–28`). |
| `update_drive_context` (tools.js:45) | `driveId*`, `drivePrompt*` | PATCH `/api/drives/{driveId}` (drive.js:121) | same route as above | Same. `drivePrompt` max 10000 chars (`drives/[driveId]/route.ts:22`). |

### 2.2 Page listing & trash listing (2 tools)

| Tool | Input | Call | Route | Response (route truth) |
|---|---|---|---|---|
| `list_pages` (tools.js:65) | `driveSlug*`, `driveId*`, `parentId?`, `recursive?` | GET `/api/drives/{driveId}/pages?ls=true[&parentId=][&recursive=true]` (page.js:16–23) | `drives/[driveId]/pages/route.ts:91` | `{mode:'ls', driveName, driveSlug, location, breadcrumb:[{id,title}], pages:[{id,title,type,hasChildren,isTaskLinked}], count, totalInDrive}` (`:263–272`). Unknown `parentId` → 404 (`:190`). Without `ls=true` the same route returns a full page **tree** (`:329`) — the SDK should expose both modes. `driveSlug` is a tool-layer nicety; the route never reads it. |
| `list_trash` (tools.js:92) | `driveSlug*`, `driveId*` | GET `/api/drives` **then** GET `/api/drives/{driveId}/trash` (page.js:319, 329) | `drives/[driveId]/trash/route.ts:17` | Tree of trashed pages (`buildTree` output, `:87–91`). **Owner/admin only** → 403 otherwise (`:44–77`) — the tool description does not mention this restriction. The preliminary GET `/api/drives` is redundant for the SDK (drive-name lookup only). |

### 2.3 Page read & metadata (2 tools)

| Tool | Input | Call | Route | Response (route truth) |
|---|---|---|---|---|
| `read_page` (tools.js:112) | `pageId*` | POST `/api/mcp/documents` `{operation:'read', pageId}` (document.js:15) | `mcp/documents/route.ts:85` (see §3) | Non-task pages: `{pageId, pageTitle, totalLines, numberedLines, content}` (`:273–279`). TASK_LIST pages: adds `pageType:'TASK_LIST'`, `taskListId`, `tasks[]` (serialized + `hasContent`), `availableStatuses[]`, `progress{total,percentage,byGroup,bySlug}` (`:253–269`). |
| `get_page_details` (tools.js:127) | `pageId*` | GET `/api/pages/{pageId}` (export.js:18) | `pages/[pageId]/route.ts:18` | Bare page object (`result.page` via `jsonResponse`, `:43`). |

### 2.4 Page write (4 tools)

| Tool | Input | Call | Route | Response (route truth) |
|---|---|---|---|---|
| `create_page` (tools.js:143) | `driveId*`, `title*`, `type*` (enum FOLDER,DOCUMENT,CHANNEL,AI_CHAT,CANVAS,SHEET,TASK_LIST), `parentId?`, `content?` | POST `/api/pages` (page.js:68) | `pages/route.ts:32` | `201` bare page row (`:111`). **DISCREPANCY (enum too narrow):** route accepts all non-experimental types — FOLDER, DOCUMENT, CHANNEL, AI_CHAT, CANVAS, **FILE**, SHEET, TASK_LIST, **CODE** — plus admin-only TERMINAL (`pages/route.ts:13–16,53–56`; `packages/lib/src/content/page-types.config.ts:306–308`; enum `packages/lib/src/utils/enums.ts:1–12`). Route also accepts `contentMode`, `systemPrompt`, `enabledTools`, `aiProvider`, `aiModel` (`pages/route.ts:19–30`) which the tool omits. Resolution: SDK enum = route enum; expose the agent-config fields. |
| `rename_page` (tools.js:174) | `pageId*`, `title*` | PATCH `/api/pages/{pageId}` (page.js:106) | `pages/[pageId]/route.ts:62` | Updated page row (`:221`). Route also accepts `content`, `aiProvider`, `aiModel`, `parentId`, `isPaginated`, `isPrivate` (share-permission gated), `expectedRevision` (optimistic concurrency → 409/428), `changeGroupId` (`:50–60`). |
| `move_page` (tools.js:192) | `pageId*`, `position*`, `newParentId?` | PATCH `/api/pages/reorder` `{pageId,newParentId,newPosition}` (page.js:287–293) | `pages/reorder/route.ts:20` | `{message:'Page reordered successfully'}` (`:85`). Scoped tokens need OWNER/ADMIN on the drive (`:37–51`). Note the field rename: tool `position` → wire `newPosition`. |
| `replace_lines` (tools.js:214) | `pageId*`, `startLine*`, `content*`, `endLine?` | POST `/api/mcp/documents` `{operation:'replace',...}` (document.js:87) | `mcp/documents/route.ts:85` (see §3) | `{pageId, pageTitle, totalLines, numberedLines, operation:'replace', affectedLines}` (`:335–342`). Out-of-range lines → 400 (`:289`); revision conflict → 409/428 (`:564–572`). |

### 2.5 Trash & restore (4 tools)

| Tool | Input | Call | Route | Response (route truth) |
|---|---|---|---|---|
| `trash_page` (tools.js:242) | `pageId*`, `withChildren?` | DELETE `/api/pages/{pageId}` body `{trash_children}` (page.js:136–140) | `pages/[pageId]/route.ts:235` | `{message:'Page moved to trash successfully.'}` (`:289`). **Parity trap:** tool default `withChildren=false`; route default when the field is *omitted* is `trash_children ?? true` (`:258`). The handler always sends the field, so behavior matches today — the SDK must also always send it explicitly (fail-closed: never rely on the server default). |
| `trash_drive` (tools.js:260) | `driveId*`, `confirmDriveName*` | GET `/api/drives/{driveId}` then DELETE `/api/drives/{driveId}` (page.js:177, 189) | `drives/[driveId]/route.ts:247` | `{success:true}` (`:319`). Owner/admin only (`:277`); Home drive → 403 (`:271`). **The name-confirmation guardrail is client-side only** (page.js:183–186); the route has no `confirmDriveName`. SDK must keep this guard in the client layer (pure function) — the API will happily trash on a bare DELETE. |
| `restore_page` (tools.js:278) | `pageId*` | POST `/api/pages/{pageId}/restore` (page.js:219) | `pages/[pageId]/restore/route.ts:86` | `{message:'Page restored successfully.'}` (`:160`). Requires the same delete/manage permission as trashing (IDOR fix, `:120–123`); not-in-trash → 400 (`:108`). |
| `restore_drive` (tools.js:292) | `driveId*` | POST `/api/drives/{driveId}/restore` then GET `/api/drives/{driveId}` (page.js:249, 257) | `drives/[driveId]/restore/route.ts:16` | `{success:true}` (`:98`). Owner-only (explicit-role scoped tokens need OWNER, ADMIN insufficient — `:34–44`); not-in-trash → 400 (`:61`). The follow-up GET is display-only. |

### 2.6 Sheet editing (1 tool)

| Tool | Input | Call | Route | Response (route truth) |
|---|---|---|---|---|
| `edit_sheet_cells` (tools.js:308) | `pageId*`, `cells*[]{address*,value*}` | POST `/api/mcp/documents` `{operation:'edit-cells', pageId, cells}` (page.js:379–385) | `mcp/documents/route.ts:85` (see §3) | `{pageId, pageTitle, cellsUpdated, operation:'edit-cells', stats{valuesSet,formulasSet,cellsCleared,sheetDimensions{rows,columns}}, updatedCells[{address,type}]}` (`:538–556`). Non-sheet page → 400 with `pageType` (`:469–473`); invalid A1 address → 400 (`:481–487`). |

### 2.7 Task management (6 tools)

| Tool | Input | Call | Route | Response (route truth) |
|---|---|---|---|---|
| `create_task` (tools.js:345) | `pageId*`, `title*`, `status?`, `priority?`, `assigneeId?`, `assigneeAgentId?`, `assigneeIds?[]`, `dueDate?`, `agentTrigger?{agentPageId*, triggerType?, prompt?, instructionPageId?, contextPageIds?≤10}` | POST `/api/pages/{pageId}/tasks` (task.js:76) | `pages/[pageId]/tasks/route.ts:312` | `201` task row with relations (`assignee`, `assigneeAgent`, `user`, `page`, `assignees[]`) + `title` + `pageId` of the auto-created child TASK_LIST page (`:591–595`). Status validated against the list's status configs → 400 with valid slugs (`:416–417`). `due_date` trigger without `dueDate` → 400 (`:395–396`). |
| `update_task` (tools.js:429) | `pageId*`, `taskId*`, `title?`, `status?`, `priority?`, `assigneeId?`, `assigneeAgentId?`, `assigneeIds?[]`, `dueDate?` | PATCH `/api/pages/{pageId}/tasks/{taskId}` (task.js:141) | `pages/[pageId]/tasks/[taskId]/route.ts:24` | Updated task with relations + `title` (`:389, :418`). Route additionally accepts `position` (`:64`) — the MCP layer deliberately routes that through `reorder_task`. Task not a direct child of `pageId` → 404 (`:59–61`). |
| `delete_task` (tools.js:486) | `pageId*`, `taskId*` | DELETE `/api/pages/{pageId}/tasks/{taskId}` (task.js:174) | `pages/[pageId]/tasks/[taskId]/route.ts:425` | Success JSON; semantics = trash the linked page ("delete by trashing", `:421–423`). Edit permission required (`:440–445`). |
| `reorder_task` (tools.js:504) | `pageId*`, `taskId*`, `position*` | PATCH `/api/pages/{pageId}/tasks/{taskId}` `{position}` (task.js:207) | same PATCH route (`:24`, `position` accepted at `:64`) | Updated task row. `position` is a 0-based slot, clamped to the list length. (The web UI's separate `pages/[pageId]/tasks/reorder/route.ts` exists but the MCP path uses the PATCH — both are valid; SDK should standardize on PATCH `{position}`.) Both routes write the single ordering rail, `pages.position` on the task's linked page — the same value a user drag writes (#2143). Responses report `position` from that rail, so it is a float, not a dense 0..n-1 index. |
| `create_task_status` (tools.js:526) | `pageId*`, `name*`, `color*`, `group*` (todo/in_progress/done), `position?` | POST `/api/pages/{pageId}/tasks/statuses` (task.js:236) | `pages/[pageId]/tasks/statuses/route.ts:80` | `201` status-config row `{id, taskListId, name, slug, color, group, position}` (`:168–188`). Slug collision → 409 (`:155`). Route also exports GET/PUT/DELETE for statuses (`:27, :195, :284`) — unexposed surface for the SDK. |
| `get_assigned_tasks` (tools.js:557) | `context?`, `driveId?`, `status?`, `priority?`, `assigneeId?`, `assigneeAgentId?`, `showAllAssignees?`, `dueDateFilter?`, `statusGroup?`, `search?`, `limit?`, `offset?` | GET `/api/tasks?…` (task.js:273–289; defaults `context` to `'drive'` iff `driveId` given) | `tasks/route.ts:64` | `{tasks:[enriched task + title, driveId, taskListPageId, taskListPageTitle, statusGroup, statusLabel, statusColor], statusConfigsByTaskList, pagination{total,limit,offset,hasMore}}` (`:457–466`). Route also accepts `startDate`/`endDate` (created-at window, `:29–30`) which the tool omits. `limit` 1–100 default 50 (`:42`). |

### 2.8 Search (3 tools)

| Tool | Input | Call | Route | Response (route truth) |
|---|---|---|---|---|
| `regex_search` (tools.js:620) | `driveId*`, `pattern*`, `searchIn?` (content/title/both), `maxResults?` | GET `/api/drives/{driveId}/search/regex?pattern&searchIn&maxResults` (search.js:15–22) | `drives/[driveId]/search/regex/route.ts:18` | `{success:true, ...searchResults}` (results/totals from `regexSearchPages`, `:126–129`). `maxResults` clamped **1–100**, default 50 (`:36–40`). Missing pattern → 400. |
| `glob_search` (tools.js:648) | `driveId*`, `pattern*`, `includeTypes?[]` (enum incl. TASK_LIST), `maxResults?` | GET `/api/drives/{driveId}/search/glob?pattern&maxResults[&includeTypes=csv]` (search.js:74–84) | `drives/[driveId]/search/glob/route.ts:21` | `{success:true, ...searchResults}` (`:136–139`). `maxResults` clamped **1–200**, default 100 (`:39–43`). **DISCREPANCY (type filter):** route's valid set is FOLDER, DOCUMENT, AI_CHAT, CHANNEL, CANVAS, SHEET, **CODE** (`:14`) — **no TASK_LIST**. The tool offers TASK_LIST (tools.js:665) which the route silently drops; if it was the only entry the filter degrades to "all types" (`:53–57` + `:118`). Resolution: SDK enum = route enum (add CODE, drop TASK_LIST) and fail closed on unsupported types instead of silently widening. |
| `multi_drive_search` (tools.js:679) | `searchQuery*`, `searchType?` (text/regex), `maxResultsPerDrive?` | GET `/api/search/multi-drive?searchQuery&searchType&maxResultsPerDrive` (search.js:135–142) | `search/multi-drive/route.ts:17` | `{success:true, searchQuery, searchType, results:[{driveId,driveName,driveSlug,matches[{pageId,title,type,excerpt}],count}], totalDrives, totalMatches, summary, stats, nextSteps}` (`:242–264`). `maxResultsPerDrive` clamped **1–50**, default 20 (`:26–30`). Per-page permission-filtered via batch principal permissions (`:190`). |

### 2.9 AI agents & models (5 tools)

| Tool | Input | Call | Route | Response (route truth) |
|---|---|---|---|---|
| `update_agent_config` (tools.js:706) | `agentPath*`, `agentId*`, `systemPrompt?`, `enabledTools?[]`, `aiProvider?`, `aiModel?` | PUT `/api/ai/page-agents/{agentId}/config` (agent.js:17) | `ai/page-agents/[agentId]/config/route.ts:57` | `{success:true, id, title, type:'AI_CHAT', message, summary, updatedFields[], agentConfig{...}, stats{...}, nextSteps[]}` (`:249–279`). Invalid tool names → 400 listing available tools (`:136–141`). Route also accepts `agentDefinition`, `visibleToGlobalAssistant`, `toolExposureMode` ('upfront'/'search'), `expectedRevision` (409/428) (`:70–80`) — unexposed by the tool. `agentPath` is decorative (never sent). |
| `list_agents` (tools.js:742) | `driveId*`, `driveSlug?`, `includeSystemPrompt?`, `includeTools?` | GET `/api/drives/{driveId}/agents?includeSystemPrompt&includeTools[&driveSlug]` (agent.js:74–83) | `drives/[driveId]/agents/route.ts:33` | `{success:true, driveId, driveName, driveSlug, agents:[AgentSummary], count, summary, stats, nextSteps}` (`:145–165`). `driveSlug` query param is ignored by the route. Per-agent view-permission filtering (`:100–102`). |
| `multi_drive_list_agents` (tools.js:769) | `includeSystemPrompt?`, `includeTools?`, `groupByDrive?` | GET `/api/ai/page-agents/multi-drive?…` (agent.js:131–137) | `ai/page-agents/multi-drive/route.ts:35` | `{success:true, totalCount, driveCount, summary, stats, nextSteps}` + (`groupByDrive` ? `agentsByDrive:[{driveId,driveName,driveSlug,agentCount,agents[]}]` : `agents:[]`) (`:167–198`). |
| `ask_agent` (tools.js:791) | `agentPath*`, `agentId*`, `question*`, `context?` | POST `/api/ai/page-agents/consult` `{agentId, question, context}` (agent.js:232) | `ai/page-agents/consult/route.ts:156` | `{success:true, agent{id,title,systemPrompt(preview),provider,model,enabledToolsCount}, question, response, context, metadata}` (`:560–572`). Credit-gated (402-class errors via `creditGateErrorResponse`) and admin-only-provider gated (`:233–246`). `agentPath` never sent. |
| `list_models` (tools.js:1458) | `provider?`, `freeOnly?` | GET `/api/ai/models[?provider&freeOnly]` (agent.js:185–190) | `ai/models/route.ts:21` | `{providers: buildModelCatalog(), defaultProvider, defaultModel}` (`:22–27`). **DISCREPANCY (three-way):** (1) the route is **public — no auth** (`:9–10`); (2) it **ignores `provider` and `freeOnly` entirely** (its `GET()` takes no request); (3) there is **no top-level `models` array** — models are nested per provider — so the handler's `response.models || []` (agent.js:199) is always `[]` and its `count` is always 0. Resolution: SDK op = no params in, `{providers, defaultProvider, defaultModel}` out; any provider/freeOnly filtering is a pure client-side function. |

### 2.10 Calendar (9 tools)

| Tool | Input | Call | Route | Response (route truth) |
|---|---|---|---|---|
| `list_calendar_events` (tools.js:821) | `startDate*`, `endDate*`, `driveId?` | GET `/api/calendar/events?startDate&endDate[&driveId]` (calendar.js:23–28) | `calendar/events/route.ts:217` | **`{events:[…], workflowEvents:[…]}`** (`:359, :481`). **DISCREPANCY (shape):** the handler treats the response as a bare array (`events.length`, `for…of events`, calendar.js:30–38) — iterating the object **throws**, so the tool errors on every non-empty result against the current route. Route accepts `context` (`user`/`drive`), `includePersonal` too (`:225–230`). Resolution: SDK output schema `{events, workflowEvents}`. |
| `get_calendar_event` (tools.js:843) | `eventId*` | GET `/api/calendar/events/{eventId}` (calendar.js:71) | `calendar/events/[eventId]/route.ts:111` | Bare event object (`:163`). 404 / 403 fail-closed via `canAccessEvent` (`:148–161`). |
| `check_calendar_availability` (tools.js:857) | `startDate*`, `endDate*`, `driveId?` | GET `/api/calendar/events?…` (calendar.js:111–116) — gap computation is **client-side** (calendar.js:118–139) | same route as `list_calendar_events` | Same `{events, workflowEvents}` — same shape **DISCREPANCY** as above. Resolution: SDK models availability as a **pure function** `computeFreeSlots(events, range) → slots[]` over the list operation (testable with plain inputs). |
| `create_calendar_event` (tools.js:879) | `title*`, `startAt*`, `endAt*`, `description?`, `location?`, `driveId?`, `allDay?`, `userIds?[]` | POST `/api/calendar/events` (calendar.js:184) | `calendar/events/route.ts:496` | `201` complete event (`:714`). **DISCREPANCY (attendees dropped):** route schema takes **`attendeeIds`**, not `userIds` (`:34–56`); the handler's `userIds` is silently stripped by zod, so invitees are never added. Route also supports `pageId`, `timezone`, `recurrenceRule{frequency,interval,byDay,byMonthDay,byMonth,count,until}`, `visibility` (DRIVE/ATTENDEES_ONLY/PRIVATE), `color`, `agentTrigger` (`:34–60`). Resolution: SDK input field is `attendeeIds`; expose the full schema. |
| `update_calendar_event` (tools.js:922) | `eventId*`, `title?`, `startAt?`, `endAt?`, `description?`, `location?`, `allDay?` | PATCH `/api/calendar/events/{eventId}` (calendar.js:223) | `calendar/events/[eventId]/route.ts:178` | Complete updated event (`:382`). Route also accepts `timezone`, `recurrenceRule`, `visibility`, `color`, `pageId`, `agentTrigger` (`:24–48`). |
| `delete_calendar_event` (tools.js:960) | `eventId*` | DELETE `/api/calendar/events/{eventId}` (calendar.js:253) | `calendar/events/[eventId]/route.ts:397` | `{success:true}` (`:474`). |
| `rsvp_calendar_event` (tools.js:974) | `eventId*`, `status*` (ACCEPTED/DECLINED/TENTATIVE) | PATCH `/api/calendar/events/{eventId}/attendees` `{status}` (calendar.js:287) | `calendar/events/[eventId]/attendees/route.ts:298` | Updated attendee row (`:392`). Route enum additionally allows `PENDING` and an optional `responseNote` ≤500 (`:21–24`) — tool subset is safe; SDK should expose both. |
| `invite_calendar_attendees` (tools.js:993) | `eventId*`, `userIds*[]` | POST `/api/calendar/events/{eventId}/attendees` `{userIds}` (calendar.js:312) | `calendar/events/[eventId]/attendees/route.ts:153` | `{attendees}` (`:283`). Route also accepts `isOptional` (`:15–18`). |
| `remove_calendar_attendee` (tools.js:1012) | `eventId*`, `targetUserId*` | DELETE `/api/calendar/events/{eventId}/attendees` **JSON body** `{targetUserId}` (calendar.js:337–340) | `calendar/events/[eventId]/attendees/route.ts:407` | `{success:true}` (`:498`). **DISCREPANCY (wrong parameter channel — behavioral bug):** the route reads **query param `?userId=`**, defaulting to the *caller* when absent (`:419` — `searchParams.get('userId') || userId`). The handler's JSON body is ignored, so the tool **removes the caller from the event instead of the target**. Resolution: SDK op = DELETE `…/attendees?userId={targetUserId}`; Phase 6 parity fixture MUST cover this. |

### 2.11 Slash commands (4 tools)

| Tool | Input | Call | Route | Response (route truth) |
|---|---|---|---|---|
| `list_commands` (tools.js:1032) | `driveId?` | GET `/api/commands[?driveId]` (command.js:15–18) | `commands/route.ts:59` | `{commands:[{…command, entryPageTitle, entryPageDriveId, entryPageAvailable, authorName}]}` (`:113–128`). Handler unwraps `.commands` ✓. |
| `create_command` (tools.js:1045) | `trigger*`, `description*`, `entryPageId*`, `driveId?`, `enabled?` | POST `/api/commands` (command.js:63) | `commands/route.ts:137` | `201 {command}` (`:270`). Trigger/description validated server-side (lengths, charset); drive-scoped commands require owner/admin. |
| `update_command` (tools.js:1075) | `commandId*`, `trigger?`, `description?`, `entryPageId?`, `enabled?` | PATCH `/api/commands/{commandId}` (command.js:107) | `commands/[commandId]/route.ts:67` | `{command}` (`:210`). |
| `delete_command` (tools.js:1105) | `commandId*` | DELETE `/api/commands/{commandId}` (command.js:137) | `commands/[commandId]/route.ts:218` | Success JSON. Auth constants shared at `commands/command-route-helpers.ts:9–10` (both allow mcp). |

### 2.12 Role management (8 tools)

All write paths are owner/admin-gated server-side; role permission maps are `Record<pageId, {canView,canEdit,canShare}>`.

| Tool | Input | Call | Route | Response (route truth) |
|---|---|---|---|---|
| `list_drive_roles` (tools.js:1121) | `driveId*` | GET `/api/drives/{driveId}/roles` (role.js:26) | `drives/[driveId]/roles/route.ts:13` | `{roles}` (`:41`). Member-gated (`:35`). |
| `get_drive_role` (tools.js:1132) | `driveId*`, `roleId*` | GET `…/roles/{roleId}` (role.js:69) | `drives/[driveId]/roles/[roleId]/route.ts:29` | `{role}` (`:60`). |
| `create_drive_role` (tools.js:1144) | `driveId*`, `name*`, `description?`, `color?`, `driveWidePermissions?{canView,canEdit,canShare}` | POST `…/roles` `{name, permissions: {} , …}` (role.js:114–119) | `drives/[driveId]/roles/route.ts:49` | `201 {role}` (`:131`); duplicate name → 409 (`:136`). **Route requires `permissions`** ("Name and permissions are required", `:78`) — the handler supplies `{}`; the SDK must too (the tool schema doesn't expose `permissions`). |
| `update_drive_role` (tools.js:1167) | `driveId*`, `roleId*`, `name?`, `description?`, `color?`, `driveWidePermissions?` | PATCH `…/roles/{roleId}` (role.js:162) | `drives/[driveId]/roles/[roleId]/route.ts:68` | `{role}` (`:151`); 409 on duplicate name. Route also accepts `isDefault` and a full `permissions` map (`:101`). |
| `delete_drive_role` (tools.js:1191) | `driveId*`, `roleId*` | DELETE `…/roles/{roleId}` (role.js:190) | same route `:162` | `{success:true}` (`:215`). |
| `set_role_page_permissions` (tools.js:1203) | `driveId*`, `roleId*`, `pageId*`, `canView?`, `canEdit?`, `canShare?` | PATCH `…/roles/{roleId}` `{permissions:{[pageId]:{canView:!!,canEdit:!!,canShare:!!}}}` (role.js:214–216) | same route | `{role}`. Server **merges** the submitted map into existing permissions (`updateDriveRole`; handler comment role.js:7–9 verified against route pass-through `:120–127`). Undefined flags coerce to `false` at the handler — fail-closed. |
| `set_role_drive_wide_permissions` (tools.js:1219) | `driveId*`, `roleId*`, `canView?`, `canEdit?`, `canShare?` | PATCH `…/roles/{roleId}` `{driveWidePermissions:{…!!}}` (role.js:243–245) | same route | `{role}`. |
| `remove_role_page_permissions` (tools.js:1234) | `driveId*`, `roleId*`, `pageId*` | PATCH `…/roles/{roleId}` `{permissions:{[pageId]:{false,false,false}}}` (role.js:272–274) | same route | `{role}`. "Remove" = all-false entry (falls back to drive-wide), not key deletion. |

### 2.13 Agent triggers (4 tools)

| Tool | Input | Call | Route | Response (route truth) |
|---|---|---|---|---|
| `set_calendar_trigger` (tools.js:1249) | `calendarEventId*`, `agentPageId*`, `prompt?`, `instructionPageId?`, `contextPageIds?≤10` | PUT `/api/calendar/events/{eventId}/triggers` (trigger.js:39) | `calendar/events/[eventId]/triggers/route.ts:134` | `{success:true}` (`:213`). Schema `.strict()`, requires prompt **or** instructionPageId (`:31–39`). Route also has GET → `{trigger}` (`:63`). |
| `delete_calendar_trigger` (tools.js:1280) | `calendarEventId*` | DELETE `…/triggers` (trigger.js:66) | same route `:221` | `{success:true}` (`:261`), idempotent. |
| `set_task_trigger` (tools.js:1294) | `taskId*`, `triggerType*` (due_date/completion), `agentPageId*`, `prompt?`, `instructionPageId?`, `contextPageIds?≤10` | PUT `/api/tasks/{taskId}/triggers` (trigger.js:115) | `tasks/[taskId]/triggers/route.ts:121` | `{trigger}` (`:227`). Schema `.strict()` (`:20–29`). Route also has GET → `{triggers}` (`:69, :117`). |
| `delete_task_trigger` (tools.js:1330) | `taskId*`, `triggerType*` | DELETE `/api/tasks/{taskId}/triggers/{triggerType}` (trigger.js:148) | `tasks/[taskId]/triggers/[triggerType]/route.ts:19` | Success JSON. **DISCREPANCY (auth):** this route is **session-only** — `SESSION_WRITE = { allow: ['session'] }` (`:14`) — so an `mcp_*` Bearer gets 401 `"MCP tokens are not permitted for this endpoint"` (`lib/auth/index.ts:284–291`). The tool cannot work with MCP tokens today. Resolution: Phase 1 must either add `'mcp'` (and later OAuth) to this route's allow-list or the registry marks the op `sessionOnly` and the parity gate asserts the 401. |

### 2.14 Scheduled workflows (4 tools)

| Tool | Input | Call | Route | Response (route truth) |
|---|---|---|---|---|
| `list_workflows` (tools.js:1351) | `driveId*` | GET `/api/workflows?driveId` (workflow.js:22) | `workflows/route.ts:31` | Bare **array** of workflow rows (`:109`). Owner/admin-gated (`:49`). Handler handles both array and `{workflows}` ✓. |
| `create_workflow` (tools.js:1362) | `driveId*`, `name*`, `cronExpression*`, `agentPageId*`, `timezone?`, `prompt?`, `instructionPageId?`, `contextPageIds?`, `isEnabled?` | POST `/api/workflows` (workflow.js:77) | `workflows/route.ts:113` | `201` workflow row (`:190`). **DISCREPANCY (schema drift):** route schema is `.strict()` with **`prompt` required** and **no `instructionPageId`** (`:19–28`). The tool's "prompt **or** instructionPageId" contract is false — sending `instructionPageId` → 400 `Invalid input` (unrecognized key), and omitting `prompt` → 400. Resolution: registry input = `{driveId, name, agentPageId, prompt (required), contextPageIds?, cronExpression, timezone?, isEnabled?}` until the route grows instruction-page support. |
| `update_workflow` (tools.js:1400) | `workflowId*`, `name?`, `cronExpression?`, `timezone?`, `isEnabled?`, `agentPageId?`, `prompt?`, `instructionPageId?`, `contextPageIds?` | PATCH `/api/workflows/{workflowId}` (workflow.js:126) | `workflows/[workflowId]/route.ts:71` | Updated workflow row (`:149`). **Same DISCREPANCY:** update schema `.strict()`, no `instructionPageId` (`:18–26`) → 400 if sent. |
| `delete_workflow` (tools.js:1423) | `workflowId*` | DELETE `/api/workflows/{workflowId}` (workflow.js:154) | `workflows/[workflowId]/route.ts:153` | `{success:true}` (`:175`). Route also has GET single (`:54, :67`) — unexposed. |

### 2.15 Members & collaborators (2 tools)

| Tool | Input | Call | Route | Response (route truth) |
|---|---|---|---|---|
| `list_drive_members` (tools.js:1436) | `driveId*` | GET `/api/drives/{driveId}/members` (member.js:22) | `drives/[driveId]/members/route.ts:9` | `{members, pendingInvites (owner/admin-only, else []), currentUserRole}` (`:47–52`). Member-gated (`:32`). |
| `list_collaborators` (tools.js:1447) | — | GET `/api/connections` (member.js:61) | `connections/route.ts:17` | `{connections: validConnections}` (`:92`); default filter `status=ACCEPTED` (`:26` — route supports `?status=` which the tool omits). |

### 2.16 Conversations, channels & activity (5 tools)

| Tool | Input | Call | Route | Response (route truth) |
|---|---|---|---|---|
| `list_conversations` (tools.js:1477) | `agentId*` | GET `/api/ai/page-agents/{agentId}/conversations` (conversation.js:22) | `ai/page-agents/[agentId]/conversations/route.ts:23` | `{conversations, pagination{page,pageSize,totalCount,totalPages,hasMore}}` (`:115–125`). Handler unwraps `.conversations` ✓. Route also has POST (create conversation, `:141`) — unexposed. |
| `read_conversation` (tools.js:1492) | `agentId*`, `conversationId*` | GET `…/conversations/{conversationId}/messages` (conversation.js:81) | `…/conversations/[conversationId]/messages/route.ts:56` | `{messages, conversationId, messageCount, pagination{hasMore,nextCursor,prevCursor,limit,direction}}` (`:190–201`). Cursor pagination params unexposed by the tool. |
| `send_channel_message` (tools.js:1511) | `pageId*`, `content*` | POST `/api/channels/{pageId}/messages` `{content}` (conversation.js:140) | `channels/[pageId]/messages/route.ts:229` | `201` message row (`:671`; thread replies `:549`). Route accepts `fileId`, `attachmentMeta`, `parentId`, `alsoSendToParent`, `quotedMessageId` (`:249–256`). **Stale tool description:** the "may only support session auth" warning (tools.js:1512) is wrong — the route allows mcp (`:117–118`). Edit permission required → 403 (`:242–247`). |
| `delete_channel_message` (tools.js:1530) | `pageId*`, `messageId*` | DELETE `/api/channels/{pageId}/messages/{messageId}` (conversation.js:195) | `channels/[pageId]/messages/[messageId]/route.ts:86` | `{success:true}` (`:142`). Author-only (`:105`) + edit permission (`:93–96`). |
| `get_activity` (tools.js:1549) | `driveId?`, `pageId?`, `limit?`, `types?[]` | **POST** `/api/activities` JSON body (conversation.js:214–223) | `activities/route.ts:39` — **GET only** | `{activities, pagination{total,limit,offset,hasMore}}` (`:235–243`). **DISCREPANCY (method + params):** the route exports **no POST** → the tool 405s on every call. The GET contract is query params `{context ('user' default), driveId, pageId, startDate, endDate, actorId, operation, resourceType, limit, offset}` (`:53–67`); there is **no `types` filter** — nearest equivalents are `operation` + `resourceType`. Resolution: SDK op = GET with the route's real query schema; drop `types`. |

---

## 3. MCP-only routes — the SDK's content-edit surface (documented fully)

### 3.1 `POST /api/mcp/documents` (`apps/web/src/app/api/mcp/documents/route.ts:85`)

Auth: `authenticateMCPRequest` — **mcp tokens only** (`:86`; session cookies are NOT accepted on this route). Drive scope checked before permissions (`:110–133`); view permission via principal model (`:136–145`); mutating ops additionally require `canEdit` → 403 `{error:'Write permission required', details}` (`:148–164`).

Input schema (zod, `:76–83`): `{operation: 'read'|'replace'|'insert'|'delete'|'edit-cells', pageId?, startLine?≥1, endLine?≥1, content?, cells?[{address,value}]}`. If `pageId` is omitted the server guesses the "current page" (`getCurrentPageId`, `:21–43`) — the SDK must always send `pageId` (fail-closed; the guess is owner-only and heuristic).

**Five operations** (the MCP server exposes only `read`, `replace`, `edit-cells`; `insert` and `delete` are live but untooled — the SDK registry should cover all five):

| Operation | Required fields | Success response | Errors |
|---|---|---|---|
| `read` (`:179`) | `pageId` | `{pageId,pageTitle,totalLines,numberedLines,content}`; TASK_LIST adds `pageType,taskListId,tasks,availableStatuses,progress` (`:253–279`) | 404 page; 403 scope/view |
| `replace` (`:282`) | `startLine`, `content` (`endLine` defaults to `startLine`) | `{…, operation:'replace', affectedLines:'s-e'}` (`:335–342`) | 400 missing/out-of-range (`:283–291`); 409/428 revision mismatch (`:564–572`) |
| `insert` (`:345`) | `startLine`, `content` (insert index clamps to EOF) | `{…, operation:'insert', insertedAt}` (`:394–401`) | 400 missing |
| `delete` (`:404`) | `startLine` (`endLine` optional) | `{…, operation:'delete', deletedLines:'s-e'}` (`:456–463`) | 400 missing/out-of-range |
| `edit-cells` (`:466`) | `cells[]` non-empty; page must be SHEET | `{pageId,pageTitle,cellsUpdated,operation,stats{valuesSet,formulasSet,cellsCleared,sheetDimensions},updatedCells[]}` (`:538–556`) | 400 non-sheet (`:469`), invalid A1 address (`:481–487`) |

All mutations go through `applyPageMutation` with `expectedRevision` (optimistic concurrency), emit websocket `content-updated`, and audit-log with `source:'mcp'` (`:302–342` etc.). Zod failure → 400 `{error: issues}` (`:574–576`).

### 3.2 `/api/mcp/drives` (`apps/web/src/app/api/mcp/drives/route.ts`)

Auth: `authenticateMCPRequest` — mcp only. **Currently unused by pagespace-mcp** (its handlers call `/api/drives`, which also accepts mcp tokens) — this is a redundant MCP twin, kept for legacy clients:

- `GET` (`:95`): list accessible drives, filtered by token scope; explicit-role scoped drives included even when the owner isn't a member (`:114–139`). Returns bare array.
- `POST` (`:22`): create drive `{name: 1–100 chars}` (`:18–20`); **scoped tokens → 403** (`:30–35`); returns `201` bare drive row (`:83`).

Resolution for the SDK: standardize on `/api/drives` (richer `DriveWithAccess` shape, dual auth); mark `/api/mcp/drives` as deprecated-parity-only. Phase 6's adapter must not regress clients that still call it.

---

## 4. Consolidated DISCREPANCY register

Every row is a RED-test candidate for Phase 6's parity gate (fixture: replay the handler's exact request against the route; assert the noted outcome).

| # | Tool | Nature | Observable failure today | Registry resolution |
|---|---|---|---|---|
| D1 | `get_activity` | Method mismatch: handler POSTs; route is GET-only (`activities/route.ts:39`) | 405 on every call | GET + real query schema; drop `types`, add `operation`/`resourceType`/`actorId`/dates/offset |
| D2 | `delete_task_trigger` | Route session-only (`tasks/[taskId]/triggers/[triggerType]/route.ts:14`) | 401 with mcp token | Add `'mcp'`+OAuth to allow-list in Phase 1, or mark op `sessionOnly` |
| D3 | `list_models` | Route public, ignores `provider`/`freeOnly`, no top-level `models` (`ai/models/route.ts:21–27`) | Filters no-op; handler always reports 0 models | Param-less op; output `{providers,defaultProvider,defaultModel}`; filtering = pure client fn |
| D4 | `list_calendar_events` / `check_calendar_availability` | Route returns `{events, workflowEvents}`, handler expects bare array (`calendar/events/route.ts:359,481` vs calendar.js:30–38) | `for…of` over object throws → tool errors on non-empty results | Output schema `{events, workflowEvents}`; availability = pure `computeFreeSlots(events, range)` |
| D5 | `create_calendar_event` | Field name: tool sends `userIds`, route accepts `attendeeIds` (`calendar/events/route.ts:55`) | Invitees silently never added | Input field `attendeeIds`; expose recurrence/visibility/timezone |
| D6 | `remove_calendar_attendee` | Param channel: tool sends JSON body `targetUserId`; route reads query `?userId=`, defaults to caller (`attendees/route.ts:419`) | **Removes the caller, not the target** | DELETE `…/attendees?userId={targetUserId}` |
| D7 | `create_workflow` / `update_workflow` | Route schemas `.strict()`, `prompt` required (create), no `instructionPageId` (`workflows/route.ts:19–28`; `workflows/[workflowId]/route.ts:18–26`) | `instructionPageId` → 400; prompt-less create → 400 | `prompt` required; no `instructionPageId` until the route supports it |
| D8 | `glob_search` | Type-filter enum drift: route set has CODE, lacks TASK_LIST (`search/glob/route.ts:14`); invalid entries silently widen the filter (`:53–57,118`) | TASK_LIST filter silently returns all types | Enum = route enum; reject unsupported types client-side (fail closed) |
| D9 | `create_page` | Type enum too narrow: route accepts FILE + CODE (+admin TERMINAL) (`pages/route.ts:13–16,53`) | SDK parity would under-expose the API | Enum = creatable types from `page-types.config.ts:306` + admin-gated TERMINAL |
| D10 | `trash_page` | Default divergence: tool `withChildren=false`, route omitted-field default `true` (`pages/[pageId]/route.ts:258`) | Latent only (handler always sends the field) | SDK always sends `trash_children` explicitly |
| D11 | `trash_drive` | `confirmDriveName` guardrail is client-side only (page.js:183–186; no such field on the route) | Bare DELETE trashes without confirmation | Keep guard as pure client fn `assertDriveNameConfirmed(drive.name, confirm)`; document server gap |
| D12 | `send_channel_message` | Stale description: "session-only, may 401" (tools.js:1512) — route allows mcp (`channels/[pageId]/messages/route.ts:117–118`) | Misleading docs only | Drop the warning; require edit permission note |
| D13 | server metadata | `server.js:33,74` reports version `5.1.1`; package.json is `5.2.3` | Client-visible version drift | `pagespace mcp` adapter derives version from package.json |

Handler-claims verified as TRUE (no discrepancy, recorded to stop re-litigation): `update_agent_config` PUT verb matches route (agent.js:15–17 comment is accurate); `reorder_task` via PATCH `{position}` is accepted (`tasks/[taskId]/route.ts:64`); role "remove" = all-false merge (role.js:259–274); RSVP uppercase enums match (`attendees/route.ts:22`); `create_drive_role` must send `permissions` (route requires it, handler defaults `{}`).

---

## 5. Zero-trust posture of this inventory (fail-closed statements)

1. **Routes are the contract.** Where handler and route disagree, the SDK implements the route and the discrepancy register documents the old behavior. No SDK operation may encode a handler-side workaround without a `D#` reference.
2. **Every operation must send explicit values for security-relevant fields** (`trash_children`, permission booleans coerced to `false`, `pageId` on `/api/mcp/documents`) — never rely on server defaults or server-side "current page" guessing.
3. **Auth acceptance is per-route, not global.** The registry must carry an `auth` capability per operation (`mcp+session`, `sessionOnly` (D2), `public` (D3)); the transport must not retry a 401 with a different credential class silently.
4. **Scoped-token semantics are part of the contract**: scoped tokens are their own drive member; several ops require OWNER/ADMIN of the token itself (`move_page`, `list_trash`, `restore_drive` OWNER-only). SDK error mapping must preserve the 401/403/404 distinctions listed above — constant-shape errors, no oracle enrichment.
5. **Optimistic concurrency is exposed, not hidden**: `expectedRevision` → 409 (mismatch) / 428 (required) on page/content/agent-config mutations must surface as typed errors.

## 6. Implied pure-function signatures (Phase 2/3 seeds)

```ts
// Registry row — the single source all surfaces derive from (Phase 2).
type Operation<In, Out> = {
  name: string;                       // e.g. 'pages.replaceLines'
  mcpToolName?: string;               // e.g. 'replace_lines' (parity mapping, §2)
  method: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE';
  path: (params: In) => string;       // pure; query-string building included
  auth: 'mcp+session' | 'sessionOnly' | 'public';
  input: z.ZodType<In>;               // fields from §2, route-verified
  output: z.ZodType<Out>;             // shapes from §2/§3, route-verified
};

// Pure decision/transform functions this inventory implies:
computeFreeSlots(events: CalendarEvent[], range: {startAt: string; endAt: string}): FreeSlot[]        // D4
assertDriveNameConfirmed(actualName: string, confirmName: string): Result<void, ConfirmMismatch>       // D11
filterModelCatalog(catalog: ProviderCatalog[], opts: {provider?: string; freeOnly?: boolean}): Model[] // D3
buildActivityQuery(filters: ActivityFilters): URLSearchParams                                          // D1
classifyApiError(status: number, body: unknown): TypedApiError  // 400/401/403/404/405/409/428/5xx, constant-shape
```

## 7. Testable assertions (RED-test seeds for downstream phases)

1. The registry contains **exactly 67 MCP-parity operations** plus the two untooled `/api/mcp/documents` ops (`insert`, `delete`) and the unexposed route surfaces flagged "unexposed" in §2 — a fixture diff against `tools.js` must be empty on names.
2. For every operation, `method+path` resolves to an existing `route.ts` exporting that method (compile-time route table test).
3. Replaying each D1–D8 legacy request against its route yields the documented failure (405, 401, empty-filter, throw-shape, dropped field, self-removal, 400, silent-widen respectively); replaying the corrected registry op succeeds.
4. `output` schemas parse real route fixtures: `{events,workflowEvents}` (calendar list), `{providers,defaultProvider,defaultModel}` (models), `{tasks,statusConfigsByTaskList,pagination}` (assigned tasks), `{activities,pagination}` (activity), bare arrays for `/api/drives` and `/api/workflows`.
5. An `mcp_*` token against a `sessionOnly` op fails **before** the network layer with a typed `AuthCapabilityError` (fail closed), matching the route's 401.
