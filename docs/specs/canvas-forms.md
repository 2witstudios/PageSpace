# Canvas Forms

How a plain `<form>` on a published Canvas page can submit data that lands as
a new row in a Sheet page. This is the human-facing reference for hand-editing
a form already provisioned via the `provision_form_target` AI tool — the tool
itself returns ready-to-embed HTML, so most authors never need this doc.

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
- **archived** — permanent; cannot be reactivated.

Both take effect on the very next submission — there is no cache or
propagation delay, since the submit endpoint re-reads status on every request.

## Security model (why this is safe to publish)

- The token is scoped to exactly `{driveId, pageId, action: 'sheet:append'}`
  — never a session, never drive membership, never anything the OAuth
  provider or `@pagespace/sdk` would imply. See `packages/db/src/schema/form-targets.ts`.
- Origin/Referer headers are never the authorization decision — only the
  token hash lookup is (`apps/web/src/app/api/public/forms/[token]/submit/route.ts`).
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
