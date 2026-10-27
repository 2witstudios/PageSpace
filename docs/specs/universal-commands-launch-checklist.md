# Universal Commands — Launch Checklist (Phase 6)

**Status:** Launch-prep deliverable. Companion to the binding UX spec
(`docs/specs/universal-commands-ux.md`). Three parts: (1) the desktop/mobile
parity audit — code-verified items checked with file references, plus a manual
QA script for what only a real device can prove; (2) the rollout plan for
widening the admin gate; (3) the user-facing changelog draft, held here until
gate-widening because the repo's only user-facing changelog surface (the
marketing blog, `apps/marketing/src/app/blog/[slug]/data.ts`) is
publish-time-only — entries go live the moment they land in `data.ts`.

Phase 0–5 are merged to master (Phase 5, #1606, landed real `/help`
execution and the shared `loadAvailableCommands` loader). See "Merge
sequencing" at the end for the remaining follow-ups.

---

## 1. Desktop / Mobile Parity Audit

The desktop app (Electron, `apps/desktop`) and mobile apps (Capacitor,
`apps/ios` / `apps/android`) load the same web bundle — there is no
command-specific code in any wrapper. Parity therefore reduces to the
platform-conditional paths inside `apps/web`, audited below.

### 1.1 Code-verified (no device needed)

Each item was verified by reading the cited source on this branch.

- [x] **Soft-keyboard Enter inserts a newline, never selects a picker row
  (spec §8).** `useEnterToSend` returns `false` on phones, tablets, and
  native non-iPad (`apps/web/src/hooks/useEnterToSend.ts:52-84`).
  `ChatTextarea` threads it as `enterSelects` into the command hook
  (`apps/web/src/components/ai/chat/input/ChatTextarea.tsx:129`), and the
  picker keyboard grammar maps Enter to `none` when `enterSelects` is false
  (`apps/web/src/lib/commands/picker-keyboard.ts:49-50`). The send gate also
  requires `enterToSend` (`ChatTextarea.tsx:172`), so on mobile Enter falls
  through to the browser default — a newline — even while the picker is open.
  Tapping is the only selection mechanism, exactly as §8 requires.

- [x] **Hardware-keyboard Enter selects (desktop, iPad + external
  keyboard).** Native iPad distinguishes external keyboards by soft-keyboard
  height (`EXTERNAL_KEYBOARD_THRESHOLD = 120`,
  `useEnterToSend.ts:35,57-65` via `useMobileKeyboard`); desktop browsers
  return `true` unconditionally (`useEnterToSend.ts:83`). With
  `enterSelects` true, Enter selects and `preventDefault`/`stopPropagation`
  keeps the message from sending (`picker-keyboard.ts:49-50`,
  `useCommandSuggestion.ts:354-361`, spec §1.7). Tab also selects;
  Shift+Tab does nothing (`picker-keyboard.ts:51-52`).

- [x] **Enter falls through to send when nothing is selectable.**
  `commandPickerBlocksEnter` requires an open picker with loaded, non-empty
  items (`ChatTextarea.tsx:158-159`); the hook passes `itemCount: 0` while
  loading (`useCommandSuggestion.ts:340-342`). Loading row or "No commands
  match" → desktop Enter sends the literal text, matching pre-command
  behavior.

- [x] **Trigger detection keys off the input stream, not keydown codes
  (spec §8).** The `/` must arrive as a *typing insertion*: `ChatTextarea`
  reads the native `InputEvent.inputType` (`ChatTextarea.tsx:229-232`) and
  `isTypingInsertion` accepts only `insertText` / `insertCompositionText`
  (`apps/web/src/lib/commands/slash-trigger.ts:66-68`). Layered/long-press
  mobile keyboard input works because those produce `input` events;
  paste/drop/autofill never open the picker (`slash-trigger.ts:169-183`).

- [x] **IME / predictive composition can't flicker the picker open
  (spec §1.1/§8).** `evaluateSlashTrigger` refuses to open while composing
  (`slash-trigger.ts:169`); composition state is tracked via
  `compositionstart`/`compositionend` (`ChatTextarea.tsx:237-244`,
  `useCommandSuggestion.ts:253-267`) and the committed composition is
  evaluated exactly once against the pre-composition value
  (`useCommandSuggestion.ts:258-267`).

- [x] **Picker maxHeight uses the visual viewport, so the list never sits
  under the mobile keyboard (spec §8).** `CommandPickerPortal` computes
  `maxHeight` from `getViewportHeight()`
  (`apps/web/src/components/commands/CommandPickerPortal.tsx:86-91`), which
  returns `window.visualViewport?.height ?? window.innerHeight`
  (`apps/web/src/services/positioningService.ts:30-31`). When the soft
  keyboard opens, the visual viewport shrinks and the cap follows.

- [x] **Small-viewport width clamping (spec §1.3/§8).** Width clamps to
  256–320 px with 8 px gutters; on viewports narrower than 272 px the
  gutters win over the 256 px floor so the picker never overflows
  horizontally (`CommandPickerPortal.tsx:93-98`). Rows stay single-line
  with truncation (`CommandPicker.tsx:146`).

- [x] **Touch selects a row on first tap; hover highlight is pointer-only
  (spec §8/§1.7).** Row selection is a plain `onClick` on the option `li`
  (`apps/web/src/components/commands/CommandPicker.tsx:112`) — no hover
  precondition, no two-tap select. `onMouseEnter` only moves the highlight
  (`CommandPicker.tsx:113`). Tap outside closes via a document
  `pointerdown` listener that exempts the picker and its anchor textarea
  (`CommandPickerPortal.tsx:66-77`).

- [x] **Settings create/edit form renders as a full-height bottom sheet on
  mobile (spec §8).** `CommandFormDialog` switches on
  `useBreakpoint('(max-width: 639px)')`
  (`apps/web/src/components/commands/CommandFormDialog.tsx:115`) and renders
  `Sheet side="bottom" className="h-full overflow-y-auto"` instead of the
  centered dialog (`CommandFormDialog.tsx:423-431`). Field behavior is the
  same component tree in both shells.

- [x] **Electron is identical to web; no `/` accelerators registered
  (spec §8).** The desktop main process registers a single accelerator,
  `CmdOrCtrl+,` for Preferences (`apps/desktop/src/main/menu.ts:14`); no
  `globalShortcut` use anywhere in `apps/desktop/src`. (The
  `apps/desktop/src/main/command-resolver.ts` file is an unrelated
  PATH-resolution helper for spawning child processes — a name collision,
  not a command-feature surface.)

- [x] **All composers share one implementation.** AI chat, the assistant
  sidebar, channels, and DMs all render `ChatTextarea`
  (`apps/web/src/components/ai/chat/input/ChatInput.tsx`,
  `apps/web/src/components/layout/middle-content/page-views/channel/ChannelInput.tsx:367-378`,
  both with `popupPlacement="top"`), so the picker/chip behavior audited
  above applies to every surface on every platform (spec §1.2).

- [x] **Accessibility wiring that mobile screen readers depend on.**
  Combobox roles + `aria-activedescendant` live on the textarea
  (`ChatTextarea.tsx:208-219,247`), options carry `role="option"` /
  `aria-selected` / accessible names including scope and shadow state
  (`CommandPicker.tsx:102-119`), and a polite live region announces result
  counts (`ChatTextarea.tsx:313-317`) (spec §9).

- [x] **Escape backstop works when focus left the textarea.** A
  capture-phase document keydown listener dismisses with trigger-position
  memory (`CommandPickerPortal.tsx:51-61`, spec §1.1/§1.3).

### 1.2 Manual QA script (real devices required)

Code can prove the logic; it cannot prove how each platform's keyboard,
viewport animation, and assistive tech actually behave. Run this script once
per platform before widening the gate: **iOS (Capacitor build), Android
(Capacitor build), iPad + external keyboard, macOS Electron, Windows
Electron.** Prereq: an admin account with ≥2 commands registered (one
personal, one drive) and one command whose description is long enough to
truncate.

| # | Step | Expectation |
|---|------|-------------|
| 1 | In an AI chat, tap the input and type `/` from the letters layer (iOS: tap `123` → `/`; Android: symbols layer or long-press) | Picker opens anchored above the input, fully visible **between the input and the top of the keyboard** — never underneath it |
| 2 | Keep typing `rel` (or a prefix of a real trigger) | List filters; no flicker from autocorrect/predictive bar; matching command ranked first |
| 3 | Press the soft keyboard's Enter/return key while the picker is open with results | A **newline** is inserted; no row is selected; the message does not send; picker closes (newline in the query ends the trigger) |
| 4 | Retype `/` at message start, then tap a row once | Single tap inserts the chip `/trigger ` with trailing space; picker closes; keyboard stays open; caret after the space |
| 5 | With the chip in the input, tap send | Message sends; chip renders in the transcript; "Using /trigger" pill appears on the AI response |
| 6 | Type `/` mid-message (after text) | Picker does NOT open; `/` is a literal character |
| 7 | Paste a string starting with `/help` into the empty input | Picker does NOT open; text stays literal |
| 8 | With predictive text / IME enabled (iOS Japanese or pinyin keyboard if available), compose text starting with `/` | Picker does not flicker during composition; evaluates once when composition commits |
| 9 | Rotate to landscape (phones) with the picker open, and on a narrow phone (<360 px width) | Picker stays within the viewport with ≥8 px margins; rows single-line with truncated descriptions |
| 10 | iPad with external keyboard: type `/`, use ↑/↓, press Enter | Arrows move the highlight in visual direction; Enter selects the row (does not send, does not newline) |
| 11 | iPad: disconnect the external keyboard, repeat with the on-screen keyboard | Enter now inserts a newline; tap selects |
| 12 | Open Settings → AI Settings → Commands → New command (phone) | Form opens as a **full-height bottom sheet**, scrollable, all fields reachable above the keyboard; Save/Cancel visible |
| 13 | In the sheet, pick an entry page, type an uppercase trigger with spaces | Live-normalizes to lowercase-hyphenated; validation errors render inline beneath fields |
| 14 | Drive settings → Commands as a non-owner member (phone) | Read-only list, disabled switches, passive notice; no Access Denied screen |
| 15 | Channel with no AI: send a message with a chip | Chip renders for all members; tooltip (long-press) includes the "No AI is in this conversation" suffix; no execution pill |
| 16 | VoiceOver (iOS) / TalkBack (Android) with the picker open | Result count announced politely; selected option announced with trigger, scope, and description |
| 17 | Electron (macOS + Windows): repeat steps 1–7 with a hardware keyboard | Identical to desktop web: Enter selects in the picker, sends otherwise; Tab completes; Escape dismisses with memory (typing after the same `/` does not reopen) |
| 18 | Electron: check app menus while an input has a `/` typed | No menu accelerator fires on `/`; typing is unaffected |

Record results in the rollout tracking page (PageSpace → Features/UI &
Product Experience/Universal Commands) before flipping the gate.

---

## 2. Rollout Plan — widening the admin gate

### 2.1 What the gate is (current state)

One client-side predicate, by design (spec §0: "gating is a visibility
switch only"):

```ts
// apps/web/src/lib/commands/command-gating.ts
export function canUseCommands(user): boolean {
  return user?.role === 'admin';
}
```

> Note: the epic tracking notes refer to a `canSeeCommandSettings` predicate;
> it was never created — settings visibility uses the same `canUseCommands`
> function. `canManageDriveCommands` (drive owner/`ADMIN`) is a *different*
> gate — drive authoring permission, not feature exposure — and does **not**
> change at rollout.

The server is intentionally not exposure-gated: every API route and the
execution resolver enforce real per-scope permissions (ownership, drive
membership, `canUserViewPage`) regardless of role. Two consequences worth
stating plainly:

1. **Widening requires zero API, schema, or permission changes.** All
   server-side behavior is already live for all users.
2. **During the gated period, a non-admin who hand-crafts API calls or chip
   serializations can create and execute commands.** This is accepted (it
   leaks nothing — all real permissions still apply; the gate hides UI, it is
   not a security boundary). Don't be surprised by non-admin rows in
   `commands` during dogfooding.

### 2.2 The one-predicate change

```ts
export function canUseCommands(
  user: { role?: string | null } | null | undefined
): boolean {
  return Boolean(user);   // was: user?.role === 'admin'
}
```

Keep the function (don't inline `true` at call sites): it remains the single
seam for any future per-plan or per-flag exposure, and
`command-gating.test.ts` pins its behavior — update those assertions in the
same commit.

### 2.3 Surfaces that light up (the complete consumer list)

Verified by grep — these are ALL the `canUseCommands` call sites:

| Surface | File | What appears |
|---|---|---|
| `/` picker in every composer | `apps/web/src/components/ai/chat/input/ChatTextarea.tsx:95` | Slash trigger, picker, chip insertion, combobox a11y wiring — in AI chat, assistant sidebar, channels, DMs |
| Settings hub row | `apps/web/src/app/settings/page.tsx:94` | "Commands" entry under AI Settings |
| Personal commands page | `apps/web/src/app/settings/commands/page.tsx:26,32` | `/settings/commands` stops redirecting non-admins |
| Drive settings hub item | `apps/web/src/app/dashboard/[driveId]/settings/page.tsx:39` | "Commands" item in drive settings nav |
| Drive commands page | `apps/web/src/app/dashboard/[driveId]/settings/commands/page.tsx:33,43` | `/dashboard/{driveId}/settings/commands` — authoring for owners/admins, read-only for members |

Already live for everyone today (not gated, so no change): chip rendering in
transcripts, `/api/commands/resolve` for chip state, execution pills on AI
responses, and command execution itself.

### 2.4 Dogfooding exit criteria (all must hold before flipping)

Concrete and checkable; run the checks over a trailing **7-day** window.

1. **Creation volume:** ≥ 10 commands exist, drive commands span ≥ 3
   distinct drives, and there are ≥ 4 distinct authors.
   `SELECT count(*) AS total, count(DISTINCT drive_id) AS drives, count(DISTINCT created_by_id) AS authors FROM commands;`
   (`count(DISTINCT drive_id)` ignores NULLs, so personal commands never
   inflate the drive count.)
2. **Execution volume:** ≥ 25 AI responses carry a command execution part
   (`data-command-execution` persisted in message parts — count via the
   messages store), including ≥ 5 uses of `/help`.
3. **Zero resolver errors:** no occurrences of the log marker
   `Command resolution failed; proceeding without injection`
   (`apps/web/src/lib/ai/core/command-resolver.ts:55`) in the window.
4. **Zero 5xx on command routes:** no `[COMMANDS_GET]`, `[COMMANDS_POST]`,
   `[COMMANDS_PATCH]`, `[COMMANDS_DELETE]`, `[COMMANDS_RESOLVE_GET]`, or
   `[COMMANDS_SUGGEST_GET]` error-log entries in the window.
5. **Skip-rate sanity:** skipped executions (`status: 'skipped'` in
   persisted execution parts) < 20% of total executions — higher means
   users are routinely hitting trashed/disabled/deleted commands and the
   settings badge/UX needs attention before widening.
6. **Manual QA:** the §1.2 device script completed on iOS, Android, and one
   Electron platform with no unresolved P0/P1 findings.
7. **Phase 5 landed or explicitly deferred:** see merge sequencing below.

### 2.5 Flip-day checklist

1. Land the §2.2 predicate change (+ updated `command-gating.test.ts`).
2. Publish the changelog entry (§3) to the marketing blog via the
   `/blog-publish` flow.
3. Announce in-product if desired (the §3 short copy is sized for that).
4. Watch criteria 3–5's log markers for 48h post-flip; the rollback is the
   same one-line predicate revert (sent chips keep rendering for everyone —
   rendering was never gated, so rollback strands nothing).

---

## 3. Changelog — user-facing entry

> **DRAFT — DO NOT PUBLISH until the §2 gate widens.** Convention: the repo
> has no root CHANGELOG.md and no in-app release-notes data file; user-facing
> feature announcements ship as marketing blog posts in
> `apps/marketing/src/app/blog/[slug]/data.ts` (see
> "usage-based-pricing-and-built-for-scale" for the prior example), which is
> a publish-time-only surface — hence this draft lives here. Publish via
> `/blog-publish` (generates the hero image and appends the entry).

**Short copy (in-product announcement / release note):**

> **Slash commands are here.** Type `/` in any AI conversation to run a
> command — a page you've registered as reusable instructions for the AI.
> The page's content guides the response, and its child pages become
> resources the AI can read on demand. Create your own in Settings → AI
> Settings → Commands, or add shared ones to a drive for your whole team.

**Blog entry (BlogPost object, ready for `data.ts`):**

```ts
"universal-commands": {
  slug: "universal-commands",
  title: "Universal Commands: Turn Any Page Into a Slash Command",
  description:
    "Type / in any AI conversation to inject a page's knowledge into the response. Commands follow the Agent Skills open standard — your page is the skill, its children are the resources the AI reads on demand.",
  image: "/blog/universal-commands.png", // generate at publish time
  author: "PageSpace Team",
  date: "<set at publish>",
  readTime: "4 min read",
  category: "Product",
  content: `
## Your pages already know things. Now the AI can be told to use them.

You keep your release checklist, your code-review standards, your brand
voice guide in PageSpace pages. Until now, getting the AI to follow them
meant pasting content into the chat or hoping search found the right page.

Universal Commands close that gap. Register a page as a command — give it a
name like \`/release-checklist\` and a description — and from then on, typing
\`/\` at the start of any message lets you pick it. Send the message and the
page's content is injected into the AI's context for that response. The AI
follows your checklist because your checklist is right there.

## Built on an open standard

Commands implement the [Agent Skills](https://agentskills.io) open standard:
the page you register is the skill body, and its direct child pages are
discoverable resources. The AI sees the children listed by title and reads
them on demand — so a lean entry page with detailed sub-pages gives you deep
knowledge without flooding the context window.

## Personal or shared

Personal commands follow you into every drive — your own shortcuts, your
rules. Drive commands are registered by a drive's owner or admins and work
for every member, so the whole team runs the same \`/standup\` or
\`/incident-review\`. Same trigger in both? Your personal command wins, and
the picker shows you exactly which one will run.

## It works everywhere

Channels, DMs, AI chats, the assistant sidebar — on web, desktop, and
mobile. Send a command in a channel with no AI and it simply rides along as
an inert chip; when an agent is mentioned, the command executes with your
permissions, never anyone else's. If a command's page is later trashed or
you lose access, the AI tells you it skipped the command instead of failing
— and answers your message anyway.

Start with \`/help\` in any AI conversation, or create your first command in
Settings → AI Settings → Commands.
`,
},
```

---

## 4. Merge sequencing & known follow-ups

- **Phase 5 (#1606) is merged** and this branch is rebased on it: `/help`
  now executes for real (`buildHelpPromptSection` renders the sender's
  precedence-resolved command list), and `planCommandExecutions` (formerly
  singular `planCommandExecution`, since generalized to resolve every
  command per message) takes an optional `{driveId}` context. The Phase 6
  edge-case tests pass unchanged against the merged behavior — the
  degradation contract held.
- **Built-ins at flip time:** `/help` is the only registered built-in
  (`packages/lib/src/commands/command-core.ts`); the remaining Phase 5
  scope (`.skill` import/export) is deferred and is not a flip blocker
  (exit criterion 7).
- **Gate is not a security boundary** (§2.1) — if product wants creation
  *blocked* (not just hidden) for non-admins during dogfooding, that's a
  server-side check in `POST /api/commands` and a deliberate spec §0
  deviation; not currently planned.
- **Resolve-endpoint batching (post-launch perf follow-up):**
  `GET /api/commands/resolve` awaits `isUserDriveMember` /
  `canUserViewPage` per id inside its loop
  (`apps/web/src/app/api/commands/resolve/route.ts:101-115`). The
  `MAX_IDS = 50` cap bounds the worst case, and chip resolution is
  off the render critical path, so this is not a launch blocker — but a
  long shared channel can pay up to ~50 sequential permission queries per
  batch. Batch or memoize per-drive membership when widening usage.
