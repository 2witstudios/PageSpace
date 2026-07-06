# Canvas Forms

How a plain `<form>` on a published Canvas page can submit data that lands as
a new row in a Sheet page. A Canvas page can have more than one — a landing
page routinely has a waitlist form, a contact form, a feedback form, each
wired independently.

## Two ways to get a form onto the page

1. **AI tool, from scratch.** Call `provision_form_target` with a target
   Sheet page id and an ordered field list (`name`, `label`, `type`,
   `required`). This writes the header row on the Sheet and returns a
   `submitUrl` plus a ready-to-embed `formHtml` string — paste it verbatim
   into the Canvas page.
2. **Hand-authored (or agent-authored) tag, wired via the Forms tab.** Write
   a plain `<form>` with real `<input name="...">`/`<textarea name="...">`
   elements — no token, no honeypot, nothing special. Then open the Canvas
   page's **Forms** tab (next to View/Code): it detects every `<form>` tag
   already in the page's content and shows each as either **wired** (already
   posting somewhere) or **unwired**. For an unwired tag, pick a target Sheet
   and click "Wire this form" — the tab parses the field list straight from
   the tag's own inputs (name → submission key, `input[type]`/`<textarea>` →
   field type, the `required` attribute → required), provisions the grant,
   and injects a hidden honeypot input plus a fetch-based submit script
   directly into that tag. **The tab never generates a `<form>` from
   scratch and never lets you type out a field list by hand** — the markup
   you already wrote is the source of truth.

Either path produces the same `form_targets` row and the same wire format,
so an AI-tool-provisioned form shows up in the tab (as "wired") once it's
linked to a Canvas page, and a tab-wired form can be paused/archived by an AI
agent via `update_form_target_status`.

## Fields are fixed at wire time

There is no "add a field later" or "archive a field" operation — once a
`<form>` is wired, its field list (and therefore its Sheet column mapping,
`fields[i]` → column `i`) never changes. If you need a different field set,
edit the `<form>` tag's inputs *before* wiring it, or delete the wired form
(below) and wire a fresh tag. This is a deliberate simplification: field-
level append/archive machinery existed only to work around a UI that
authored fields from scratch; since fields are now derived from markup you
already control, editing the markup directly is the natural path.

## The convention

1. **Field names are the contract.** Each `<input name="...">` /
   `<textarea name="...">` must match a wired field's `name` exactly. The
   submit endpoint validates against a strict schema built from those exact
   names — unknown fields are rejected, not ignored.
2. **The honeypot field is required.** Every wired form includes a hidden
   input named `_hp` (see `HONEYPOT_FIELD_NAME` in
   `packages/lib/src/forms/honeypot.ts`), positioned off-screen via inline
   styles (not `display:none`, which some bots special-case). Do not remove
   it or give it a real label — a filled-in `_hp` causes the submission to be
   silently dropped (the caller still gets a 200, no error, no signal that
   spam was detected).
3. **Submit via `fetch`, not a native form POST.** A native `<form action>`
   submission would navigate the page to the JSON response. The injected
   script intercepts `submit`, posts JSON to `submitUrl`, and (if present)
   shows a status message in a `[data-role="form-status"]` element — a
   hand-authored tag isn't required to have one.
4. **Wiring assigns a deterministic DOM id**, `pagespace-form-{formTargetId}`
   (replacing any id the tag already had), so the injected script can find
   its own element and so the Forms tab can recognize an already-wired tag
   on a later load (see `packages/lib/src/forms/form-html.ts`'s
   `wireFormBlock`, and `apps/web/.../canvas/parse-form-tags.ts`). A wired
   block is also wrapped in `<!-- pagespace:form:{id} start/end -->` markers.

## Managing a live form

Call `update_form_target_status` (or use the Forms tab) to pause, resume, or
delete a wired form:

- **paused** — submissions are rejected (identical to an unknown token — no
  oracle for whether a token exists), resumable later.
- **archived, via delete** — permanent; cannot be reactivated (enforced
  server-side — a reactivation attempt is rejected, not silently accepted).
  Deleting a form via the Forms tab **removes its `<form>` tag (and injected
  honeypot/script) from the Canvas page entirely** — see `deleteFormBlock` in
  `packages/lib/src/forms/embed-html.ts` — so archiving never leaves a dead,
  permanently-404ing tag behind on the published page. The underlying
  `form_targets` row and its submission history/Sheet data are untouched;
  only the embed is removed. If a form target is somehow still wired
  server-side but its tag can no longer be found in content (hand-edited
  away outside the tab), the Forms tab surfaces it separately so its grant
  can still be archived.

Both take effect on the very next submission — there is no cache or
propagation delay, since the submit endpoint re-reads status on every request.

## Security model (why this is safe to publish)

- The token is scoped to exactly `{driveId, pageId, action: 'sheet:append'}`
  — never a session, never drive membership, never anything the OAuth
  provider or `@pagespace/sdk` would imply. See `packages/db/src/schema/form-targets.ts`.
- Origin/Referer headers are never the authorization decision — only the
  token hash lookup is (`apps/web/src/app/api/public/forms/[token]/submit/route.ts`).
- CORS is wide open (`Access-Control-Allow-Origin: *`) for the same reason:
  the submitting page's origin is unbounded by design (any published-site
  host or custom domain) and carries no authorization weight, so there's
  nothing an origin restriction would protect that the token doesn't already.
- Every accepted submission is attributed to the form's owning `createdBy`
  with `changeGroupType: 'automation'`, going through the same
  `applyPageMutation` activity-logging pipeline as any other page edit — so
  there's an audit trail, not a bolt-on log.
- Rate-limited independently by IP and by token prefix
  (`DISTRIBUTED_RATE_LIMITS.FORM_SUBMISSION`), so a single leaked token can't
  be hammered from many IPs to bypass the per-IP limit.

## v1 scope

- One destination type: append a row to a Sheet. Document-append is not
  supported.
- One active form per Sheet — the header row is always written at row 1;
  wiring a second form against a Sheet that already has an active one is
  rejected (a partial unique index enforces this in Postgres). A Canvas
  page, in contrast, can have any number of wired forms, each against its
  own Sheet.
- No visual form builder — forms are hand-authored HTML (by a human or an AI
  agent); the Forms tab wires up markup you wrote, it doesn't generate a
  drag-and-drop UI's worth of it for you.
- No header-drift detection — `fields[i]` maps to sheet column `i` fixed at
  wire time and is never re-derived from the sheet's live header row. If
  someone manually edits or reorders the header row afterward, submissions
  keep writing to the original columns with no detection or warning.
- Best-effort tag matching — wiring locates a bare `<form>` tag's exact text
  via a DOM-parsed `outerHTML`, which is usually but not guaranteed to be
  byte-identical to the original source (attribute-quoting/self-closing
  normalization). A failed match aborts the wire attempt (and archives the
  just-created grant) rather than silently duplicating or corrupting content.
