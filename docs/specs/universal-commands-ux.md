# Universal Commands — UX Specification (Phase 0)

**Status:** Locked behavior contract. Every UI phase (picker, settings, transcripts, execution) builds against this document; acceptance criteria below become test specs.

**Feature summary:** Users register pages as slash commands. Typing `/` at the start of a message in any AI input opens a command picker; selecting a command inserts an inline chip that, on send, injects the command's entry page into AI context. Commands implement the [Agent Skills open standard](https://agentskills.io): the command's **entry page is the SKILL.md** (injected on use) and its **direct children are discoverable resources** the AI reads on demand.

This spec describes the **perfected end state**. Implementation lands in phases; the spec never scope-cuts.

---

## 0. Definitions & Model

| Term | Meaning |
|------|---------|
| **Command** | A registration mapping a `trigger` (Agent Skills name) + `description` to an **entry page**. |
| **Trigger** | The slash name typed by the user, e.g. `/release-checklist`. Satisfies Agent Skills name rules (§10). |
| **Entry page** | The page injected into AI context when the command is used — the SKILL.md equivalent. |
| **Resources** | The entry page's direct children. Listed to the AI as available resources; read on demand, never bulk-injected. |
| **Scope** | Where the command is registered: `built-in` (platform-shipped), `personal` (user-scoped, follows the user everywhere), `drive` (drive-scoped, visible to all drive members). |
| **Shadowing** | Two enabled commands share a trigger across scopes. Resolution precedence: **built-in > personal > drive**. The losing command is "shadowed" for that user in that drive. |
| **Chip** | The inline token rendered in the input after picking a command, serialized as `/[Label](commandId:command)`. |

### Command resolution

- **Given** a user in drive D types `/foo`, **should** resolve against the union of: built-in commands, the user's personal commands, and drive D's commands — deduplicated by trigger using precedence built-in > personal > drive.
- **Given** a personal command and a drive command share trigger `foo`, **should** execute the personal one, and the picker **should** show the drive one with a shadow indicator (§1.6).
- **Given** the same trigger exists in two different drives, **should** never conflict — drive commands only resolve within their drive.
- **Given** a disabled command, **should** be excluded from resolution and from the picker (it appears only in settings lists).

### Exposure gating (launch)

- **Given** a user whose `role !== 'admin'` (same check as `apps/web/src/app/settings/page.tsx` `isAdmin`), **should** see no command UI anywhere: no picker on `/`, no Commands settings pages, no Commands drive tab. `/` types as a literal character.
- **Given** an admin user, **should** see the full feature.
- **Given** the gate widens later, **should** require no UX change — gating is a visibility switch only.

---

## 1. The Command Picker

The picker **mirrors the mention picker's interaction grammar exactly** — `apps/web/src/components/mentions/MentionPicker.tsx` (panel), `MentionPickerPortal.tsx` (portal/positioning), `apps/web/src/hooks/useSuggestion.ts` (trigger detection lifecycle) — and the visual density of the emoji picker (`apps/web/src/components/ui/emoji-picker.tsx`). Only deltas are specified; everything unspecified behaves identically to mentions.

### 1.1 Trigger detection

Delta from mentions: `@` triggers anywhere after whitespace (`useSuggestion.ts` `defaultTriggerPattern`); `/` triggers **only at the start of the message** (Slack/Discord convention), and **only one command per message**.

- **Given** an empty input, when the user types `/`, **should** open the picker anchored to the input.
- **Given** an input containing only whitespace (spaces/newlines), when the user types `/`, **should** open the picker (position-0-or-only-whitespace rule).
- **Given** any non-whitespace character before the cursor's `/` (e.g. `hello /`), **should NOT** open the picker; `/` is a literal character.
- **Given** a message that already contains a command chip, when the user types `/` anywhere (including at the start after deleting text before the chip), **should NOT** open the picker — one command per message.
- **Given** the picker is open and the user keeps typing (`/rel`), **should** treat the text after `/` as the filter query (§1.4), mirroring `useSuggestion.ts`'s `textAfterTrigger` query extraction.
- **Given** the user deletes back past the `/`, **should** close the picker (mirrors `useSuggestion.ts` close-when-no-trigger branch).
- **Given** the user dismissed the picker with Escape and continues typing after the same `/`, **should NOT** reopen for that trigger position (mirrors `dismissedTriggerRef` in `useSuggestion.ts:100-103,222`); deleting the `/` and retyping it resets the dismissal.
- **Given** an IME composition is in progress (`compositionstart` fired, `compositionend` not yet — the `isComposing` guard in `ChatTextarea.tsx:81,122`), **should NOT** open the picker until composition ends; if the committed composition result begins with `/` at position 0, **should** then evaluate trigger detection once.
- **Given** a `/` typed mid-message then text before it deleted so the `/` is now at position 0, **should NOT** retroactively open the picker — detection runs only on input events at the trigger position, never on unrelated edits.
- **Given** a paste that results in a message starting with `/` (e.g. pasting `/foo bar`), **should NOT** open the picker — paste is not a trigger keystroke. The text stays literal.

### 1.2 Surfaces

- **Given** any AI-capable input — AI chat (`apps/web/src/components/ai/chat/input/ChatTextarea.tsx` consumers), assistant sidebar, channels, DMs, thread composers — **should** offer the same picker with identical behavior.
- **Given** a channel or DM **without** an AI participant, **should** still offer the picker and chip insertion (the chip is inert on send — §6).

### 1.3 Open/close lifecycle

Mirrors `MentionPickerPortal.tsx` exactly:

- **Given** the picker opens, **should** render in a `createPortal` to `document.body`, `position: fixed`, `zIndex: 50`, in a `bg-popover border border-border rounded-md shadow-md` container (`MentionPickerPortal.tsx:136-138`).
- **Given** `popupPlacement='top'` (docked inputs — the default for chat/channel composers, see `ChannelInput.tsx:378`), **should** position above the input using the `bottom` strategy; **given** `popupPlacement='bottom'` (centered/empty-state inputs), below using `top` — both via `positioningService.calculateTextareaPosition` semantics.
- **Given** the viewport edges, **should** clamp width to 256–320 px and left position to ≥8 px from either edge, and cap `maxHeight` to the space between the anchor and the viewport edge minus 8 px (`MentionPickerPortal.tsx:115-133`).
- **Given** the picker is open, **should** close on: Escape (capture-phase document listener, `MentionPickerPortal.tsx:100-110`), click outside, selection, the trigger `/` being deleted, or the input unmounting.
- **Given** the picker closes, **should** restore focus to the element focused before it opened (`returnFocusRef`, `MentionPickerPortal.tsx:41-48`).
- **Given** the picker opens, **should** reset query to the text already typed after `/` (`initialQuery`), and reset selection index to 0 (`MentionPickerPortal.tsx:51-57`).

### 1.4 Filtering & list content

- **Given** an open picker with empty query, **should** list all resolvable enabled commands for this user + drive, ordered: built-in, personal, drive; alphabetical by trigger within each scope. Shadowed commands appear (with indicator), disabled commands do not.
- **Given** a query `q`, **should** filter with 200 ms debounce (mirrors `MentionPickerPortal.tsx:88-97`) matching `q` case-insensitively against trigger (prefix matches ranked first, then substring) and description (substring). Shadowed commands remain in filtered results.
- **Given** results are loading, **should** show the mention picker's loading row: spinner + "Loading…" (`MentionPicker.tsx:105-109`).
- **Given** a query with no matches, **should** show empty state copy: **"No commands match “{q}”"**.
- **Given** the user has no commands at all (no built-ins surfaced, none registered), **should** show: **"No commands yet. Create one in Settings → AI Settings → Commands."** where the settings path is a link that navigates there and closes the picker.
- **Given** a row, **should** render (left → right, mirroring `MentionPicker.tsx:113-160` row anatomy): `/trigger` in `text-sm font-medium`, the scope badge, the shadow indicator when applicable, and the description in `text-xs text-muted-foreground truncate`. Single-line rows, same `px-3 py-2` density.
- **Given** a row's description is truncated, **should** show the full description in a tooltip on hover/focus (delay per the app's standard `Tooltip`).

Deltas from mentions: **no tabs**, and **no inner search input on trigger-opened invocations**. The mention picker's All/People/Pages/Groups tabs (`MentionPicker.tsx:90-102`) do not apply; commands are one category. Unlike `MentionPickerPortal`'s autofocused search `Input`, the `/`-triggered picker has no search field of its own — the query is the text typed after `/` in the message input, and focus stays there (§9). A search input with placeholder **"Search commands…"** (mirroring `MentionPickerPanel`'s input) appears only in button-opened popover variants of the panel, if any surface adds one; none is required at launch.

### 1.5 Scope badges

- **Given** a personal command, **should** show badge **"Personal"**; a drive command, **"Drive"**; a built-in, **"Built-in"** — rendered in the compact badge style of the mention picker's group badge (`MentionPicker.tsx:129-135`): `text-xs`, rounded, tinted background, distinct hue per scope (personal = primary tint, drive = indigo tint matching the mention group badge, built-in = muted/neutral).
- **Given** any badge, **should** be announced to screen readers as part of the option's accessible name (e.g. "/release-checklist, drive command, shadowed").

### 1.6 Shadow indicator

- **Given** a command that is shadowed for this user in this drive (e.g. a drive `/foo` shadowed by the user's personal `/foo`), **should** render the row dimmed (`opacity-60`, matching the disabled-card treatment in `apps/web/src/app/settings/personalization/page.tsx:152`), with an indicator icon + tooltip: **"Shadowed by your personal command /{trigger}. The personal command runs instead."** (or **"Shadowed by the built-in command /{trigger}…"** as appropriate).
- **Given** a shadowed row is selected anyway, **should** insert the **winning** command's chip (resolution always follows precedence; the picker never lets you bypass it).

### 1.7 Keyboard navigation

Mirrors `useSuggestion.ts` `handleKeyDown` (lines 279-323) and `MentionPickerPanel` `handleKeyDown` (lines 55-71):

- **Given** placement `bottom`, ArrowDown **should** move selection down, ArrowUp up, both wrapping at the ends.
- **Given** placement `top`, arrow directions **should** invert (ArrowUp moves toward the visually-upper item) exactly as `useSuggestion.ts:289-304` does — visual direction always matches key direction.
- **Given** Enter with a selected item, **should** select it (insert chip, §2.1) and `preventDefault`/`stopPropagation` so the message does not send (the `context.isOpen` guard in `ChatTextarea.tsx:120`).
- **Given** Tab with a selected item, **should** also select it (delta from mentions, which ignore Tab; Tab-to-complete is the Slack/Discord convention). Shift+Tab does nothing special.
- **Given** Escape, **should** dismiss without inserting and mark this trigger position dismissed (§1.1).
- **Given** mouse hover over a row, **should** move the selection highlight to it (`onMouseEnter` → `onSelectionChange`, `MentionPicker.tsx:122`); click selects.
- **Given** the picker is open, all other typing **should** pass through to the input and update the query; navigation keys never leak into the textarea.

---

## 2. The Chip in the Input

The chip reuses the mention chip machinery: tracked ranges via the pattern in `apps/web/src/hooks/useMentionTracker.ts`, painted by `MentionHighlightOverlay` over a transparent textarea (`ChatTextarea.tsx:179-199`).

### 2.1 Insertion & serialization

- **Given** a command is selected from the picker, **should** insert at the trigger position: display text `/{trigger}` plus a trailing space (mirroring `appendSpace`, `useSuggestion.ts:133`), register a tracked range (mirroring `onMentionInserted` → `registerMention`), place the caret after the space, close the picker, and return focus to the input.
- **Given** the message is serialized to its markdown/API form, **should** encode the chip as **`/[Label](commandId:command)`** — structurally parallel to mentions' `@[Label](id:type)` (`useMentionTracker.ts:12`, `MENTION_REGEX`). `Label` is the trigger string; `commandId` is the stable command registration id (not the entry page id — renames and entry-page swaps must not break sent history).
- **Given** a draft is restored (e.g. via the editing store) containing `/[Label](commandId:command)`, **should** re-parse into display text `/{Label}` + tracked range, exactly as `markdownToDisplay` does for mentions (`useMentionTracker.ts:20-54`).

### 2.2 Appearance

- **Given** a chip in the input, **should** render through the highlight overlay in the same visual language as mention chips: primary-tinted rounded token over the transparent textarea text, typography locked to the textarea (`CHAT_TYPOGRAPHY`, `ChatTextarea.tsx:20` — the overlay/textarea line-height sync constraint applies unchanged).
- **Given** a chip and a mention coexist in one message (`/foo` then `@Alice` later), **should** both render via the same overlay pass; ranges never overlap because the chip is anchored at position 0 and mentions cannot precede it.

### 2.3 Editing & deletion

Mirrors the mention tracker's overlap-removal model (`useMentionTracker.ts` `updateMentionPositions` + the `validMentions` exact-text check):

- **Given** the caret immediately after the chip, Backspace **should** delete into the chip's text; any edit overlapping the tracked range drops the range, dissolving the chip into plain text (which, no longer matching `/{trigger}` exactly, stays plain). This is the same atomicity model mentions have — no special-cased whole-chip delete, but the chip never survives partial edits as a half-chip.
- **Given** a dissolved chip's text is manually re-typed to `/trigger`, **should NOT** silently re-chip — only picker selection creates a chip. Plain `/foo` text sends as literal text with no injection.
- **Given** text typed before the chip (making the chip no longer at message start), **should** keep the chip valid for send — chip validity is set at insertion; position-0 is a *picker-opening* rule, not a send-time rule. (Rationale: matching Slack, users may prepend a salutation after picking; the command still applies to the whole message.)
- **Given** the input is cleared (send or `clear()`), **should** drop all tracked ranges.
- **Given** a sent message is later edited (message edit flows), the chip **should** be preserved as an immutable token: the editor re-parses `/[Label](commandId:command)` into a chip, edits around it behave as above, and deleting it removes the command from the message. Re-editing **does not** re-execute the command — execution only ever happens when an AI responds (§6), never as a side effect of editing history.

### 2.4 Send

- **Given** a message containing a chip is sent to an AI surface, **should** send the serialized form; the server resolves `commandId`, injects the entry page (SKILL.md) into context, and lists the entry page's direct children as on-demand resources.
- **Given** the chip's command was deleted or disabled between insertion and send, **should** send normally and degrade gracefully — rendering per §5.2, execution skip per §7.2. The input does not block send.

---

## 3. Settings — Personal Commands

**Location:** Settings → **AI Settings** → **Commands** — a new entry in the "AI Settings" section of the settings hub (`apps/web/src/app/settings/page.tsx:82-100`), sibling of Personalization, at route `/settings/commands`. Hub row: icon `SlashSquare` (lucide), title **"Commands"**, description **"Register pages as slash commands for AI"**.

**Layout conventions** mirror `apps/web/src/app/settings/personalization/page.tsx`: `container max-w-4xl mx-auto py-10 px-10 space-y-8`, ghost "Back to Settings" button, `h1` with icon, `Card` sections, `sonner` toasts, SWR + auth-redirect loading states (`Loader2` spinner page while loading).

### 3.1 List

- **Given** the page loads, **should** show the user's personal commands in a card list, each row: `/trigger` (monospace-weight emphasis), description (truncated, tooltip for full), entry page title (link, opens the page), an enable/disable `Switch`, and an overflow/row affordance for Edit and Delete.
- **Given** zero personal commands, **should** show an empty state card: **"No commands yet"** with subtext **"Commands let you inject a page's knowledge into any AI conversation by typing /its-name."** and a primary **"New command"** button.
- **Given** a command whose entry page is in the trash or no longer accessible, **should** badge the row **"Entry page unavailable"** (destructive-tinted badge) with tooltip **"The entry page for this command is in the trash or you've lost access to it. The command is skipped until this is fixed."**
- **Given** the enable/disable switch is toggled, **should** apply optimistically with toast **"Command /{trigger} enabled"** / **"Command /{trigger} disabled"**, reverting on error with toast **"Failed to update command"** (mirroring the optimistic toggle pattern in `personalization/page.tsx:69-84`).
- **Given** a personal command that shadows a drive command in at least one of the user's drives, **should** show the shadow indicator with tooltip **"This command shadows a drive command with the same trigger."**

### 3.2 Create / Edit form

Opens as a dialog (or inline card on mobile) with fields:

1. **Trigger** — text input, prefixed with a literal `/` adornment. Auto-lowercases as the user types; spaces are converted to hyphens on input.
2. **Description** — textarea, helper text below: **"Describe what this command does *and when the AI should use it.* This is shown in the picker and given to the AI."** Live character counter `n / 1,024`.
3. **Entry page** — page picker reusing the mention search machinery: the self-fetching `MentionPicker` (`MentionPicker.tsx:179-245`) with `allowedTypes={['page']}` and `crossDrive` enabled, in a popover (`MentionPickerPopover`, `MentionPicker.tsx:260-287`). Selected page renders as a chip with title + drive name and an × to clear.
4. **Enabled** — switch, default on.

- **Given** the form is opened for editing, **should** prefill all fields; changing the trigger is allowed and takes effect immediately on save (sent history is unaffected because chips store `commandId`).
- **Given** Save with all validations passing, **should** persist, close, toast **"Command /{trigger} created"** / **"Command /{trigger} updated"**, and the picker reflects it immediately (no refresh).
- **Given** Save fails server-side, **should** keep the form open with toast **"Failed to save command"**.
- **Given** unsaved changes and an attempted dismiss, **should** confirm discard.

### 3.3 Validation states (inline, on blur + on submit)

All errors render inline beneath their field in destructive text. Exact copy in §10. Advisory warnings render in amber/warning style and **never block save**.

- **Given** an entry page is selected, **should** immediately fetch its size and, if it exceeds ~5,000 tokens or 500 lines, show the advisory warning (§10, W1) under the field — non-blocking.
- **Given** a trigger that collides with an existing enabled command, **should** show the relevant collision error (personal duplicate, built-in reserved) or — for drive-command collisions — the non-blocking shadow notice (§10, W2), since shadowing is legal.

### 3.4 Delete

- **Given** Delete is chosen, **should** confirm with a destructive dialog: title **"Delete /{trigger}?"**, body **"This removes the command for you. Pages are not deleted. Messages that already used this command keep their chip but show it as removed."** Buttons: Cancel / **Delete command** (destructive).
- **Given** deletion succeeds, **should** toast **"Command /{trigger} deleted"**.

---

## 4. Settings — Drive Commands Tab

**Location:** a new **"Commands"** item in drive settings (`apps/web/src/app/dashboard/[driveId]/settings/`), following the drive settings hub conventions (`SettingsRow` sections, same skeleton/loading patterns as `settings/page.tsx` there). Route: `/dashboard/[driveId]/settings/commands`.

### 4.1 Access

Delta from the drive settings hub, which hard-blocks non-managers (`canManage = drive?.isOwned || drive?.role === 'ADMIN'` with an Access Denied screen): the Commands route is **readable by every drive member**.

- **Given** an owner or admin (`isOwned || role === 'ADMIN'` — same predicate the hub uses), **should** get full authoring: create, edit, delete, enable/disable.
- **Given** a member without those roles, **should** see the same list **read-only**: no New button, no row actions, switches rendered disabled, with a passive notice: **"Only drive owners and admins can manage drive commands."**
- **Given** a member deep-links to the route, **should** see the read-only view (not the hub's Access Denied screen).

### 4.2 List, form, validation

Identical to §3.1–3.4 with these deltas:

- Scope copy says "drive": empty state subtext **"Drive commands are available to everyone in this drive."**; delete dialog body **"This removes the command for everyone in this drive. Pages are not deleted. Messages that already used this command keep their chip but show it as removed."**
- The entry-page picker is scoped to the current drive (`MentionPicker` with `driveId`, `crossDrive=false`) — a drive command's entry page must live in that drive, so every member who can use the command can have its source attributed (access is still checked per user at execution, §5.3).
- Duplicate check is against the drive's own commands (error E6); a collision with some member's personal command is invisible here (shadowing is per-user and surfaced in the picker, §1.6).
- Each row also shows the author ("Added by {name}").

---

## 5. Transcript Rendering

Sent-message rendering goes through `apps/web/src/components/messages/RichText.tsx`. Mentions are preprocessed from `@[label](id:type)` into chip elements (`preprocessMentions`, `RichText.tsx:15-19`; chip styles at lines 262-281). Commands extend the same pipeline.

### 5.1 Normal rendering

- **Given** a sent message containing `/[Label](commandId:command)`, **should** render an inline chip displaying `/{Label}` in the mention-chip visual language (`rounded-md`, primary-tinted background, `text-sm font-medium`, `RichText.tsx:269,278`), distinguishable from mentions by the leading `/` and a small command glyph.
- **Given** hover/long-press/focus on the chip, **should** show a tooltip: **"/{trigger} — {description}"** plus a scope line ("Personal command" / "Drive command" / "Built-in command").
- **Given** the viewer clicks the chip and has access to the entry page, **should** navigate to the entry page (parallel to the page-mention anchor behavior, `RichText.tsx:260-275`).
- **Given** the chip appears in channel history, DM history, AI chat history, thread replies, and quoted messages, **should** render identically in all of them.

### 5.2 Deleted / disabled commands

- **Given** the command registration was deleted after the message was sent, **should** still render the chip (label is stored in the serialization) but muted (`bg-muted text-muted-foreground`), non-navigable, tooltip: **"This command no longer exists."**
- **Given** the command is disabled, **should** render the chip normally but with tooltip suffix: **"This command is currently disabled."** Disabled state affects *new* executions, not historical rendering.

### 5.3 Revoked-access / trashed entry pages

- **Given** the viewer lacks access to the entry page, **should** render the chip normally (the trigger + description are not secrets within the conversation) but non-navigable; click shows tooltip **"You don't have access to this command's page."**
- **Given** the entry page is in the trash at render time, **should** render the chip with the unavailable treatment of §5.2 and tooltip: **"This command's page is in the trash."**

---

## 6. Channels & DMs Without an AI Participant

- **Given** a channel/DM with no AI participant, when a message with a chip is sent, **should** deliver and render the chip for everyone (§5.1) with **no execution** — the chip is inert.
- **Given** an inert chip, **should** add a tooltip suffix: **"No AI is in this conversation, so this command didn't run."**
- **Given** an AI (agent/assistant) later responds in that conversation in a context that includes the message, execution semantics apply at that point — execution always happens at AI-response time, never at send time.
- **Given** an AI participant is present (agent in channel, assistant in AI chat), the command **should** execute when that AI responds to the message.

---

## 7. Execution Feedback

What the user sees when the AI responds with an injected command.

### 7.1 Context indicator

- **Given** the AI begins responding to a message that used `/foo`, **should** show a context indicator attached to the assistant's response (above the streaming content, in the same slot family as tool-activity indicators): a small pill **"Using /foo"** with the command glyph.
- **Given** the response completes, **should** keep the indicator persistently on the message (collapsed/subtle), so transcripts show *that* a command informed the answer. Tooltip: **"The page “{entry page title}” was added to the AI's context for this response."**
- **Given** the AI reads one of the command's child resources during the response, **should** surface it through the existing tool-call activity UI (read_page et al.) — no new UI; resources are normal reads.

### 7.2 Degraded execution

- **Given** at AI-response time the entry page is trashed, or the *sender* has lost access to it, or the command was deleted/disabled, **should** skip injection and render a visible notice in the indicator slot: **"Skipped /foo — {reason}"** where reason is one of: **"its page is in the trash"**, **"you no longer have access to its page"**, **"the command no longer exists"**, **"the command is disabled"**.
- **Given** a skip, the AI **should** still respond to the message text normally; the skip notice is informational, never an error state that blocks the response.
- **Given** the advisory size threshold is exceeded (entry page grew past ~5k tokens after registration), **should NOT** skip — inject anyway; the threshold is advisory at authoring time only.

---

## 8. Mobile (Capacitor) & Desktop (Electron)

Same components everywhere; platform deltas only.

- **Given** a touch keyboard, typing `/` from the symbols layer at message start **should** open the picker identically — detection is input-event-based, not keydown-based, so layered/long-press keyboard input works.
- **Given** IME/predictive composition on mobile, the composition guard of §1.1 applies (`isComposing || e.nativeEvent.isComposing`, `ChatTextarea.tsx:122`); the picker must not flicker open on intermediate composition states.
- **Given** the mobile keyboard is open, the picker's `maxHeight` math **should** use the visual viewport (`getViewportHeight()` / `window.visualViewport`, `MentionPickerPortal.tsx:115-116`) so the list sits fully between the input and the keyboard top — never under the keyboard. Keyboard open/height state comes from `useMobileKeyboard` (`apps/web/src/hooks/useMobileKeyboard.ts`) / the `--keyboard-height` CSS var.
- **Given** a small viewport (<360 px wide), the picker width clamp (256–320 px, §1.3) **should** hold with the 8 px edge margins; rows stay single-line with truncation.
- **Given** mobile, Enter inserts a newline rather than sending (`useEnterToSend`, `ChatTextarea.tsx:120`); with the picker open, tapping a row selects. Enter from an external keyboard on tablet behaves as desktop (§1.7).
- **Given** touch, row hover-highlight (§1.7) doesn't exist; the first tap selects directly (no two-tap select).
- **Given** Electron desktop, behavior is identical to web; no Electron-specific accelerators are registered for `/`.
- **Given** mobile settings, the create/edit form of §3.2 renders as a full-height sheet instead of a centered dialog; field behavior is identical.

---

## 9. Accessibility

`MentionPickerPanel` already provides `role="listbox"` / `role="option"` / `aria-selected` (`MentionPicker.tsx:113-120`) — mirror that, and close its gaps (the mention picker has **no** combobox wiring, no `aria-activedescendant`, no live region; the command picker must do this properly, and these improvements should be back-ported to mentions when convenient):

- **Given** the picker is closed, the message textarea **should** carry `role="combobox"`, `aria-expanded="false"`, `aria-haspopup="listbox"`.
- **Given** the picker opens, **should** set `aria-expanded="true"` and `aria-controls` to the listbox id; DOM focus **stays in the textarea** (the user keeps typing the query there — delta from `MentionPickerPortal`'s autofocused inner search `Input`, which steals focus; the command picker filters from the message input itself and has no inner search field on trigger-opened invocations).
- **Given** keyboard selection moves, **should** update `aria-activedescendant` on the textarea to the active option's id; options carry `aria-selected`.
- **Given** results change, **should** announce via a polite live region: **"{n} commands available"** / **"No commands match"**.
- **Given** an option, its accessible name **should** include trigger, scope, shadow state, and description (§1.5).
- **Given** the picker closes for any reason, focus **should** end on the textarea with the caret where the user left it (§1.3 focus-restore).
- **Given** a chip in the transcript, **should** be focusable (`tabindex=0` when navigable) with the tooltip content available as its accessible description; inert/unavailable states (§5.2–5.3, §6) are part of the description.
- **Given** the execution indicator (§7), **should** be a polite live-region announcement once per response: **"Using command /foo"** or the skip notice text.
- **Given** settings forms, every validation error **should** be programmatically associated with its field via `aria-describedby` and announced on submit failure; the size advisory uses `role="status"`, errors use `role="alert"`.
- **Given** reduced-motion preference, picker open/close **should** not animate (consistent with `useReducedMotion` usage in `ChannelInput.tsx`).

---

## 10. Validation Rules & Exact Copy

Trigger rules are the Agent Skills name rules: 1–64 chars, lowercase alphanumeric + hyphens, no leading/trailing/consecutive hyphens. Description: required, 1–1,024 chars. All checks run inline on blur and on submit; E-codes block save, W-codes never do.

The canonical enforcement lives in the shared validation lib `packages/lib/src/commands/command-core.ts` (`validateCommandTrigger`, `validateCommandDescription`, `RESERVED_TRIGGERS`, `resolveCommandPrecedence` — Phase 1). The UI must apply the same rules client-side using the copy below; the lib's own error strings are server/API-facing and are never shown verbatim in forms.

| Code | Condition | Exact copy |
|------|-----------|------------|
| E1 | Trigger empty | `Trigger is required.` |
| E2 | Trigger > 64 chars | `Trigger must be 64 characters or fewer.` |
| E3 | Invalid characters (after auto-lowercase/space→hyphen normalization) | `Trigger can only contain lowercase letters, numbers, and hyphens.` |
| E4 | Leading or trailing hyphen | `Trigger can't start or end with a hyphen.` |
| E5 | Consecutive hyphens | `Trigger can't contain consecutive hyphens.` |
| E6 | Duplicate within same scope | Personal: `You already have a command named /{trigger}.` · Drive: `This drive already has a command named /{trigger}.` |
| E7 | Reserved by built-in | `/{trigger} is reserved for a built-in command. Choose a different trigger.` |
| E8 | Description empty | `Description is required.` |
| E9 | Description > 1,024 chars | `Description must be 1,024 characters or fewer.` |
| E10 | No entry page selected | `Choose an entry page for this command.` |
| W1 | Entry page > ~5,000 tokens or > 500 lines (advisory) | `This page is large (about {tokens} tokens / {lines} lines). Commands work best when the entry page stays under ~5,000 tokens / 500 lines — move details into child pages, which the AI reads on demand.` |
| W2 | Personal trigger collides with a drive command (advisory) | `This will shadow the drive command /{trigger} in {drive name}. Your personal command will run instead.` |

- **Given** any E-code is active, the Save button **should** be disabled and the first errored field focused on attempted submit.
- **Given** only W-codes are active, Save **should** be enabled; warnings persist visibly until the condition clears.
- **Given** the user types uppercase or spaces in the trigger field, **should** normalize live (lowercase; space→hyphen) rather than erroring — E3 fires only for characters that can't be normalized (e.g. `!`, emoji).

---

## 11. Forward Compatibility (Non-Goals)

- **Cmd+K palette:** out of scope. The picker, chip serialization, and resolution rules are designed so a future global command palette can reuse them unchanged (commands are addressable by `commandId`, resolution is input-surface-independent). Nothing in this spec may assume `/`-typing is the *only* invocation path.
- **Multiple commands per message, mid-message triggers, arguments (`/foo bar=baz`):** explicitly not in this spec; the serialization format leaves room (text after the chip is ordinary message text passed to the AI).
- **Marketplace / sharing of commands across drives:** not in scope; scope model (§0) is the contract future scopes extend.

---

## Appendix A — Mirrored-Component Index

| Behavior | Mirrors | Cited |
|---|---|---|
| Trigger detection lifecycle, dismissal memory, suppression after insert | `useSuggestion.ts` | §1.1, §2.1 |
| Picker panel density, rows, loading/empty, listbox roles | `MentionPicker.tsx` (`MentionPickerPanel`) | §1.4, §9 |
| Portal, positioning, clamps, Escape, focus restore | `MentionPickerPortal.tsx` | §1.3, §8 |
| Placement-aware arrow inversion, Enter/Escape handling | `useSuggestion.ts:279-323` | §1.7 |
| Chip range tracking, overlap-dissolve on edit, markdown↔display | `useMentionTracker.ts` | §2.1, §2.3 |
| Transparent-text + overlay chip painting, typography lock | `ChatTextarea.tsx` + `MentionHighlightOverlay` | §2.2 |
| IME composition guard, Enter-to-send suppression while open | `ChatTextarea.tsx:113-130` | §1.1, §1.7, §8 |
| Popover-button picker variant (settings entry-page field) | `MentionPickerPopover` / `ChannelInputFooter.tsx` emoji+mention popovers | §3.2 |
| Transcript chip rendering pipeline | `RichText.tsx` (`preprocessMentions`, custom anchor) | §5 |
| Settings page layout, optimistic toggle, toasts | `app/settings/personalization/page.tsx` | §3 |
| Settings hub section/row | `app/settings/page.tsx`, `SettingsRow` | §3 |
| Drive settings gating predicate & hub conventions | `app/dashboard/[driveId]/settings/page.tsx` | §4 |
| Mobile keyboard height / visual viewport sizing | `useMobileKeyboard.ts`, `positioningService.ts` | §8 |
