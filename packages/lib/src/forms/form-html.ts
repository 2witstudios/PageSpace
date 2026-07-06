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

/**
 * Generates a complete, ready-to-embed <form> block (fetch-based submit +
 * hidden honeypot input) for a provisioned form target. Pure string-building —
 * no IO. The honeypot input is visually hidden via inline styles rather than
 * `display:none`/`hidden` (which some bots special-case and skip filling).
 */
export function buildFormHtml({ fields, submitUrl, formId = 'pagespace-form' }: BuildFormHtmlInput): string {
  const safeFormId = escapeHtml(formId);
  const fieldsMarkup = fields.map(buildFieldMarkup).join('\n');

  return `<form id="${safeFormId}">
${fieldsMarkup}
<label style="position:absolute;left:-9999px;top:-9999px;" aria-hidden="true">
<input type="text" name="${HONEYPOT_FIELD_NAME}" tabindex="-1" autocomplete="off">
</label>
<button type="submit">Submit</button>
<p data-role="form-status"></p>
</form>
<script>
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
        status.textContent = 'Thanks — your submission was received.';
        form.reset();
      })
      .catch(function () {
        status.textContent = 'Something went wrong. Please try again.';
      });
  });
})();
</script>`;
}
