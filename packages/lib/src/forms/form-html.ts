import type { FormFieldDef } from '@pagespace/db/schema/form-targets';
import { escapeHtml } from '../canvas/render-document';
import { HONEYPOT_FIELD_NAME } from './honeypot';

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
  const safeSubmitUrl = escapeHtml(submitUrl);
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
  var form = document.getElementById(${JSON.stringify(safeFormId)});
  var status = form.querySelector('[data-role="form-status"]');
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var data = {};
    new FormData(form).forEach(function (value, key) {
      data[key] = value;
    });
    fetch(${JSON.stringify(safeSubmitUrl)}, {
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
