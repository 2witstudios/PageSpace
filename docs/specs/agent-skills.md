# Agent Skills — discoverable, loadable, discardable capabilities

Status: shipped (first iteration). Companion to `universal-commands-ux.md` and
`universal-commands-palette-readiness.md` — this spec resolves the palette memo's
deferred §2 question (model-side command discovery) with the shape that memo
recommended.

## The capability primitive

Tools, built-in skills, and user/drive commands are one primitive —
`{ name, kind: 'tool' | 'skill', description }` — with three verbs:

| Verb | Tools | Skills / commands |
|---|---|---|
| **Discover** | names-by-category listing (search exposure mode) + `tool_search` | SKILLS catalog (stable prompt) / AVAILABLE COMMANDS (volatile) + the same `tool_search` |
| **Load** | `tool_search` → parameter schema | `load_skill` → instruction body as a tool result |
| **Act** | `execute_tool` / direct call | model follows the instructions; child resources via `read_page` |

A skill is a Universal Command with a code-shipped body: built-in skills are
`BUILTIN_COMMANDS` entries with `kind: 'skill'`
(`packages/lib/src/commands/command-core.ts`), so the `/` picker, `/help`,
chip invocation, precedence resolution (`builtin > user > drive`), and
`RESERVED_TRIGGERS` all consume one registry by construction. User/drive
commands are model-loadable through the same path without any migration.

## Architecture (three tiers, per the Agent Skills open standard)

**Tier 1 — metadata catalog.**
- Built-in skills render as a `SKILLS:` section appended to the **stable
  system prompt** (`buildBuiltinSkillCatalog`,
  `apps/web/src/lib/ai/core/skill-catalog.ts`). Eligibility gates run before
  any token is spent: the agent must have `load_skill`, and each skill's
  `requiredTools` must intersect the agent's tools (`isSkillEligible`,
  hasAny semantics). The section varies only with tool configuration —
  stable per conversation, prefix-cache-safe. It applies uniformly,
  including custom-systemPrompt agents (capability metadata, not behavior).
- User/drive commands render as an `AVAILABLE COMMANDS:` section on the
  **volatile turn context** (last user message — never the system prompt;
  the list is per-viewer and edit-churned). Budgeted at ~2k chars with a
  deterministic degradation ladder: 200-char descriptions → 80-char →
  names-only → capped name list + omission note. Names never silently
  vanish inside the cap. Zero standing cost for users with no commands.
- `tool_search` searches the whole corpus (deferred tools + built-in skills
  + sanitized command entries) and returns kind-tagged results with
  `load_skill("name")` pointers.

**Tier 2 — `load_skill`** (`apps/web/src/lib/ai/tools/skill-tools.ts`, a
core tool: upfront in search exposure mode, retained in read-only mode).
Resolution is trigger-based against the same precedence-resolved list as the
picker; built-ins return the code body via `resolveBuiltinInjection`,
user/drive commands go through `resolveCommandInjectionById` — the exact
hostile-input pipeline the chip path uses (shape validation, owner/member
gate indistinguishable from not_found, enabled/trash checks, use-time
`canUserViewPage`). The result is a **tool result** (streamText's only
mid-stream injection channel; append-only, prefix-cache-safe) wrapped in
`<skill_instructions>` framing — tool output is weighted as information by
default, so the framing is load-bearing. Same 60k truncation contract and
listed-not-loaded child manifest as chip injection
(`buildSkillLoadResult`, command-processor.ts). Failures degrade to soft
error strings; a load can never fail the turn.

**Tier 3 — resources.** The entry page's direct children are listed, never
bulk-loaded; the model reads them with `read_page` on demand (already
elidable).

## Discard

`load_skill` is in `DEFAULT_ELIDABLE_TOOLS`
(`packages/lib/src/ai/tool-result-eliding.ts`): stale loads collapse to the
deterministic stub ("call load_skill again with the same arguments"), which
is exactly true — loads are stateless and re-fetchable, deliberately without
an "already loaded" dedup short-circuit. `protectMostRecentByArgs` keeps the
**newest load per skill** un-elided regardless of the boundary (the Agent
Skills standard requires active skill instructions to survive pruning);
superseded loads of the same skill decay normally. Skill payloads are
ordinary tool results, so `prepareHistoryForModel` token budgeting counts
them with no extra seam.

## Bodies

Code-shipped markdown modules in `apps/web/src/lib/ai/skills/bodies/`
(server-only — command-core is client-imported and must not carry them),
guard-tested < 500 lines / < 20k chars, each source-verified against the
code it describes:

| Skill | Encodes |
|---|---|
| `canvas-websites` | iframe sandbox + CSP reality, theme bridge, `/dashboard/{driveId}/{pageId}` link convention, publish rewriting, verbatim `formHtml` rule |
| `spreadsheets` | SheetDoc format, complete formula function table, cross-sheet refs (incl. the stored-error quirk), `#ERROR`/`#CYCLE` semantics |
| `task-management` | linked TASK_LIST child pages, status slug groups, `SUBTASKS_INCOMPLETE` do-not-retry, agent assignees, triggers |
| `writing-documents` | HTML vs markdown content modes, line-numbered read→edit workflow, `inserted: false` pitfall, mention syntax |

Descriptions follow the trigger formula (third person, what + when, user
vocabulary front-loaded) and pass `validateCommandDescription`. Where a
skill covers inline-instructions text verbatim-or-better, the always-on
bullet slimmed to a pointer (full text remains the fallback for agents
without `load_skill`).

## Surfaces

Wired: page chat route, Global Assistant (whose bespoke drifted instruction
block was replaced by the shared `buildGlobalAssistantInstructions`).
`load_skill` is callable-but-unadvertised anywhere else that composes
`pageSpaceTools` (consult, headless machine sessions, workflows, v1
completions) — adding their catalogs is additive follow-up.

## Growth path (documented, not built)

- **Search-backed deferral** (> ~100 catalog entries, per cross-industry
  data: metadata-stub catalogs hold to low hundreds; beyond that move the
  long tail behind `tool_search` only and keep a hot set listed).
- **Construction governance**: agents can already author commands
  (`create_command`); agent-authored skills going live should get a
  proposal → human-approve staging step (OpenClaw Skill Workshop / Hermes
  write-approval precedent) before any autonomous authoring loop.
- **Telemetry-driven ordering**: `load_skill` invocations are logged per
  skill (`skill-tools.ts`); use counts to order catalog degradation
  (least-loaded lose descriptions first) and to justify or retire packs.
- **Eval harness**: per-skill should-trigger / should-not-trigger prompt
  sets with hit-rate measurement, and with-vs-without-skill A/B checks that
  output follows conventions (canvas link shapes, verbatim form embeds).

## Invariants (hold these in review)

1. The system prompt stays byte-identical across turns; every dynamic
   injection is an append (volatile block or tool result), never a splice.
2. Skill/command descriptions rendered into any prompt pass
   `clipDescription` — they are user-authored data, and the sanitization is
   a security property.
3. The chip path and `load_skill` resolve through the same permission
   functions; a load the picker wouldn't offer must be indistinguishable
   from not_found.
4. Catalog output is deterministic: same inputs → identical bytes.
