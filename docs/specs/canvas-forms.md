# Canvas Forms

How a plain `<form>` on a published Canvas page can submit data that lands as
a new row in a Sheet page. This is the human-facing reference for hand-editing
a form already provisioned via the `provision_form_target` AI tool — the tool
itself returns ready-to-embed HTML, so most authors never need this doc.

## Setting one up without an AI agent

A Canvas page has a **Forms** tab (next to View/Code) for creating and
managing a form target directly: pick a target Sheet, define fields, and the
generated HTML is embedded into the page automatically. It's backed by the
same `form_targets` row and the same provisioning path as
`provision_form_target` — an AI-tool-provisioned form appears in the tab too
once it's linked to a Canvas page (`canvasPageId`), and a tab-provisioned form
can be managed by an AI agent via `update_form_target_status`.

Fields are **append-only** once a target exists — mirroring Google Forms:
reordering or removing a field would misalign already-collected columns, so
the tab only lets you append a new field, edit a label/type/required flag, or
archive a field to retire it without losing its column's history. Adding a
field after creation can't regenerate the full embedded `<form>` (the raw
submit token is only ever available once, at creation), so the tab returns a
standalone `<input>`/`<label>` snippet to paste into the already-embedded
form instead.

## The convention

1. **Provision first.** Call `provision_form_target` with the target Sheet's
   page id and an ordered field list (`name`, `label`, `type`, `required`).
   This writes the header row on the Sheet and returns a `submitUrl` plus a
   ready-to-embed `formHtml` string. The token embedded in `submitUrl` is
   public-safe: it authorizes ONLY appending rows to that one Sheet, nothing
   else — see "Security model" below.
2. **Field names are the contract.** Each `<input name="...">` /
   `<textarea name="...">` must match a `name` from the provisioned field
   list exactly. The submit endpoint validates against a strict schema built
   from those exact names — unknown fields are rejected, not ignored.
3. **The honeypot field is required.** Every generated form includes a hidden
   input named `_hp` (see `HONEYPOT_FIELD_NAME` in
   `packages/lib/src/forms/honeypot.ts`), positioned off-screen via inline
   styles (not `display:none`, which some bots special-case). Do not remove
   it or give it a real label — a filled-in `_hp` causes the submission to be
   silently dropped (the caller still gets a 200, no error, no signal that
   spam was detected).
4. **Submit via `fetch`, not a native form POST.** A native `<form action>`
   submission would navigate the page to the JSON response. The generated
   snippet intercepts `submit`, posts JSON to `submitUrl`, and shows a status
   message in a `[data-role="form-status"]` element.

## Managing a live form

Call `update_form_target_status` with the `formTargetId` (returned by
`provision_form_target`) to pause, resume, or archive it:

- **paused** — submissions are rejected (identical to an unknown token — no
  oracle for whether a token exists), resumable later.
- **archived** — permanent; cannot be reactivated. Enforced server-side (a
  reactivation attempt is rejected, not silently accepted), and the Forms tab
  disables the status control once archived. To replace an archived form,
  use the tab's "Set up a new form" — it provisions a fresh target against
  (optionally) a different Sheet and takes over the Canvas page's embed;
  the archived target's history and Sheet data are untouched. The
  replacement's HTML is embedded in the OLD form's position — the Canvas
  content is marked with `<!-- pagespace:form:{id} start/end -->` comments
  (see `packages/lib/src/forms/embed-html.ts`) so the tab can find and
  replace that block in place rather than appending after content that may
  have changed substantially since. If those markers were hand-edited away,
  the replacement is appended at the end instead, same as a first-time create.

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
  provisioning a second form against a Sheet that already has a header will
  overwrite it.
- No visual form builder — forms are hand-authored HTML (by a human or an AI
  agent), never a drag-and-drop UI.
- No header-drift detection — `fields[i]` maps to sheet column `i` fixed at
  provisioning time and is never re-derived from the sheet's live header row.
  If someone manually edits or reorders the header row afterward, submissions
  keep writing to the original columns with no detection or warning.
