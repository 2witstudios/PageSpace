# Universal Commands — Palette Readiness Audit & Level‑1 Disclosure Memo (Phase 5)

Status: audit + decision memo only — nothing in this document is an implementation
commitment. Companion to `universal-commands-ux.md` (§11 declared the Cmd+K palette a
forward-compatibility non-goal; this document verifies that the shipped surfaces honor
that promise).

---

## 1. Cmd+K Palette Readiness Audit

A future global command palette needs four things: a command registry, a per-viewer
"what can I see here?" query, per-viewer resolution of existing references, and an
invocation path that doesn't care which input surface produced it. All four exist
today as named, React-free exports. **Verdict: consumable without rework.**

| Surface | Where | Palette-ready? |
|---|---|---|
| Registry (built-ins, validation, precedence) | `packages/lib/src/commands/command-core.ts` | ✅ Pure module, named exports (`BUILTIN_COMMANDS`, `resolveCommandPrecedence`, `validateCommandTrigger`, `validateCommandDescription`, `buildHelpPromptSection`), zero React/Next/DB imports. Runs anywhere — server, client, future desktop palette process. |
| Per-viewer command list | `GET /api/commands/suggest` (`apps/web/src/app/api/commands/suggest/route.ts`) + shared loader `apps/web/src/lib/commands/available-commands.ts` (`loadAvailableCommands`) | ✅ Session-auth'd, per-viewer, `q` prefix-ranked, `driveId`-scoped with membership enforcement; returns precedence-resolved winners **and** shadowed losers with `scope`/`shadows`/`shadowedBy` — everything a palette row needs. Phase 5 extracted the query into `loadAvailableCommands`, so a server-rendered palette (or any new endpoint) can consume the same list without going through HTTP, and the picker and the AI's `/help` answer can never drift apart. |
| Per-viewer reference resolution | `GET /api/commands/resolve` (`apps/web/src/app/api/commands/resolve/route.ts`) | ✅ Batch (≤50 ids), viewer-scoped states (`ok` / `restricted` / `deleted`), built-in ids (`builtin:{trigger}`) handled without DB. A palette rendering recents/pins resolves them exactly like transcript chips do. |
| Invocation | Chip token `/[label](commandId:command)` at message start; resolved server-side by `planCommandExecution` (`apps/web/src/lib/ai/core/command-resolver.ts`) with **sender** permissions | ✅ Input-surface-independent by design (UX spec §11): any surface that inserts the same token into a composer gets identical execution, including built-ins (no entry page required) and the `/help` dynamic section. The execution cores (`command-processor.ts`, `command-resolver.ts`, `available-commands.ts`) import no React. |

Caller obligations a palette inherits (by design, not gaps): it must supply the current
`driveId` (drive context is the caller's knowledge, as in the chat routes), and
membership for that drive is verified by the surface (suggest 403s; the resolver
degrades to personal+built-ins). Nice-to-haves that would be **additive, non-breaking**
if a palette wants them later: usage-frequency ranking and keyboard-shortcut metadata
on `CommandSummary`.

### 1.1 Quick Create (Alt+N) surfacing

`QuickCreatePalette` (`apps/web/src/components/create/QuickCreatePalette.tsx`) is a
strictly *creation* flow: a two-phase (type-select → name-entry) shadcn `CommandDialog`
that ends in `POST /api/pages` and navigation to the new page. Commands don't fit
either phase. Executing a command requires a message composer to carry the chip — the
palette has no chat target, so "run /standup" from Alt+N would have to invent one
(which conversation? which agent?), conflating creation with invocation and breaking
the chip-at-message-start contract the whole execution path is built on.

**Recommendation: do not surface commands in Quick Create.** The only defensible entry
would be a "New command…" item that deep-links to the command-creation settings flow
(commands are settings-managed metadata over existing pages, not a page type, so they
don't belong in the page-type grid either). That shortcut is better owned by the future
Cmd+K palette, which can host both "create command" and "run command in current
composer" with real context. Build nothing in QuickCreatePalette now.

---

## 2. Level‑1 Disclosure Evaluation (decision memo)

**Question:** should every AI request inject the sender's available-command metadata
(trigger + description — the Agent Skills "metadata level"), so agents can suggest
commands unprompted ("you have /standup for exactly this")?

**Cost.** With `loadAvailableCommands`, the list is two or three DB round-trips per
message (personal + drive command queries in parallel, plus one batched entry-page
permission check) — tolerable, but currently paid only when a command actually runs. The token
cost is the real line item: a trigger (≤64 chars) plus a useful description (~100–200
chars of the allowed 1,024) is roughly 40–60 tokens per command. A user with 5 personal
+ 10 drive commands adds ~600–900 tokens to **every** request — chat, agent mentions,
global assistant — whether or not commands are relevant. At the description cap, a
50-command drive could add ~15k tokens per request. The list also varies per
user/drive and changes whenever anyone edits a command, so injecting it ahead of
stable prompt sections would churn provider prompt caches; it would have to sit after
the stable prefix.

**Benefit.** Discoverability for users who never type `/`, and proactive suggestions
mid-conversation. Real, but speculative at current command counts (most users today
have zero commands, making the standing cost pure overhead for the majority).

**Recommendation: defer — do not ship for launch.** `/help` (phase 5) now answers the
explicit discovery ask with the same data, on demand, at zero standing cost. If
unprompted suggestion proves wanted post-launch, prefer the cheaper shapes first:
(a) a `list_commands` tool the agent calls when it senses a fit (on-demand, no
per-request tokens), or (b) metadata injection gated to users with ≥1 command, capped
(e.g. top N by recency), trigger + first sentence only, placed after the stable system
prompt. Either is additive on top of `loadAvailableCommands` with no rework.
