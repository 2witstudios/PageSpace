import type { FormFieldDef } from '@pagespace/db/schema/form-targets';
import { escapeHtml } from '../utils/html';
import { HONEYPOT_FIELD_NAME } from './honeypot';

/**
 * JSON.stringify a value for safe embedding inside an inline <script> JS
 * string context. JSON.stringify already produces valid JS-string escaping
 * for quotes/backslashes/control chars — the one gap is `<`, which it does
 * NOT escape, so a value containing `</script>` could otherwise break out of
 * the script block. `<` is JSON- and JS-legal and parses to the same value.
 */
function jsonScriptSafe(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export interface BuildFormHtmlInput {
  fields: FormFieldDef[];
  submitUrl: string;
  /** DOM id for the generated <form>, in case a page embeds more than one. */
  formId?: string;
}

/** Markup for a single field — a `<label>` wrapping its control. */
function buildFieldMarkup(field: FormFieldDef): string {
  const safeName = escapeHtml(field.name);
  const safeLabel = escapeHtml(field.label);
  const requiredAttr = field.required ? ' required' : '';

  const control =
    field.type === 'textarea'
      ? `<textarea name="${safeName}"${requiredAttr}></textarea>`
      : field.type === 'checkbox'
        ? `<input type="checkbox" name="${safeName}"${requiredAttr}>`
        : `<input type="${field.type}" name="${safeName}"${requiredAttr}>`;

  return `<label>${safeLabel}${control}</label>`;
}

/** Fetch-based submit handler, shared by both a from-scratch generated form
 *  and an existing tag being wired up. Looks up `formId` by DOM id — assumes
 *  the caller has already ensured the <form> carries that id. Guards
 *  `status` being present since a hand-authored form (wireFormBlock's case)
 *  won't necessarily have a `[data-role="form-status"]` element. */
function buildSubmitScript(formId: string, submitUrl: string): string {
  return `<script>
(function () {
  var form = document.getElementById(${jsonScriptSafe(formId)});
  var status = form.querySelector('[data-role="form-status"]');
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var data = {};
    new FormData(form).forEach(function (value, key) {
      data[key] = value;
    });
    fetch(${jsonScriptSafe(submitUrl)}, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
      .then(function (response) {
        if (!response.ok) throw new Error('submit failed');
        if (status) status.textContent = 'Thanks — your submission was received.';
        form.reset();
      })
      .catch(function () {
        if (status) status.textContent = 'Something went wrong. Please try again.';
      });
  });
})();
</script>`;
}

const HONEYPOT_MARKUP = `<label style="position:absolute;left:-9999px;top:-9999px;" aria-hidden="true">
<input type="text" name="${HONEYPOT_FIELD_NAME}" tabindex="-1" autocomplete="off">
</label>`;

/**
 * Generates a complete, ready-to-embed <form> block (fetch-based submit +
 * hidden honeypot input) for a provisioned form target. Pure string-building —
 * no IO. The honeypot input is visually hidden via inline styles rather than
 * `display:none`/`hidden` (which some bots special-case and skip filling).
 *
 * Used by the AI tool (provision_form_target), which generates a form from
 * scratch before any HTML exists yet. Contrast with wireFormBlock, which
 * augments a <form> tag a human/agent already wrote.
 */
export function buildFormHtml({ fields, submitUrl, formId = 'pagespace-form' }: BuildFormHtmlInput): string {
  const safeFormId = escapeHtml(formId);
  const fieldsMarkup = fields.map(buildFieldMarkup).join('\n');

  return `<form id="${safeFormId}">
${fieldsMarkup}
${HONEYPOT_MARKUP}
<button type="submit">Submit</button>
<p data-role="form-status"></p>
</form>
${buildSubmitScript(formId, submitUrl)}`;
}

export interface WireFormBlockInput {
  /** The existing <form>...</form> markup exactly as authored (by a human or
   *  an AI agent) — its inputs are preserved as-is, never regenerated. */
  formOuterHtml: string;
  formTargetId: string;
  submitUrl: string;
}

/**
 * Wires an already-authored <form> tag up to a form target, for the Forms
 * settings tab's "detect existing tags" flow: gives the tag a deterministic
 * id (so the injected script can find it — any pre-existing `id` attribute
 * is replaced), appends a hidden honeypot input just before its closing tag,
 * and appends a fetch-based submit handler after it. The form's own inputs
 * and markup are never touched otherwise — this only adds what's needed to
 * make an existing tag publicly submittable.
 *
 * Callers are responsible for wrapping the result in
 * `<!-- pagespace:form:{id} start/end -->` markers (see embed-html.ts) so it
 * can later be found and removed as a unit.
 */
export function wireFormBlock({ formOuterHtml, formTargetId, submitUrl }: WireFormBlockInput): string {
  const domId = `pagespace-form-${formTargetId}`;

  const withId = formOuterHtml.replace(/<form\b([^>]*)>/i, (_match, attrs: string) => {
    const attrsWithoutId = attrs.replace(/\s+id=("[^"]*"|'[^']*')/i, '');
    return `<form id="${escapeHtml(domId)}"${attrsWithoutId}>`;
  });

  const withHoneypot = withId.replace(/<\/form>/i, `${HONEYPOT_MARKUP}\n</form>`);

  return `${withHoneypot}\n${buildSubmitScript(domId, submitUrl)}`;
}
