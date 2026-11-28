import { HONEYPOT_FIELD_NAME } from '@pagespace/lib/forms/honeypot';

export type FormFieldType = 'text' | 'email' | 'textarea' | 'checkbox';

export interface FormFieldDef {
  name: string;
  label: string;
  type: FormFieldType;
  required: boolean;
}

export interface DetectedFormTag {
  /** The tag's exact outerHTML as re-serialized by the browser's HTML
   *  parser. Used to locate this tag's position in the raw content when
   *  wiring it up (see embedWiredBlock in @pagespace/lib/forms/embed-html).
   *  NOTE: this is a best-effort match, not guaranteed byte-identical to the
   *  original source text — the parser can normalize attribute quoting,
   *  self-closing slashes, etc. Callers must treat a failed exact-match
   *  lookup as a real failure, not silently give up. */
  outerHtml: string;
  /** Fields derived from the tag's own input/textarea/select descendants, in
   *  document order — this becomes the form_target's stored field list once
   *  wired, so column mapping matches the tag's actual inputs exactly. */
  fields: FormFieldDef[];
  /** The form_target id this tag is already wired to, if its `id` attribute
   *  follows the `pagespace-form-{id}` convention wireFormBlock assigns.
   *  Undefined for an unwired (bare) <form> tag. */
  wiredFormTargetId?: string;
}

const SKIPPED_INPUT_TYPES = new Set(['submit', 'button', 'hidden', 'reset', 'image']);
const WIRED_ID_PATTERN = /^pagespace-form-(.+)$/;

function humanizeFieldName(name: string): string {
  const spaced = name.replace(/[_-]+/g, ' ').trim();
  if (!spaced) return name;
  return spaced.replace(/\b\w/g, (char) => char.toUpperCase());
}

function fieldTypeFor(control: Element): FormFieldType {
  if (control.tagName.toLowerCase() === 'textarea') return 'textarea';
  const type = (control.getAttribute('type') || 'text').toLowerCase();
  return type === 'checkbox' || type === 'email' ? type : 'text';
}

function deriveFields(formElement: Element): FormFieldDef[] {
  const fields: FormFieldDef[] = [];
  const seen = new Set<string>();

  formElement.querySelectorAll('input[name], textarea[name], select[name]').forEach((control) => {
    const name = control.getAttribute('name');
    if (!name || name === HONEYPOT_FIELD_NAME || seen.has(name)) return;

    if (control.tagName.toLowerCase() === 'input') {
      const type = (control.getAttribute('type') || 'text').toLowerCase();
      if (SKIPPED_INPUT_TYPES.has(type)) return;
    }

    seen.add(name);
    fields.push({
      name,
      label: humanizeFieldName(name),
      type: fieldTypeFor(control),
      required: control.hasAttribute('required'),
    });
  });

  return fields;
}

/**
 * Finds every <form> tag in a Canvas page's raw HTML content and derives its
 * field list from its own inputs — the field-definition wizard this replaced
 * required a human to redundantly re-type field names/types/required flags
 * that the actual markup already states. Runs entirely client-side (DOMParser
 * is a browser API); this module must not be imported from server code.
 */
export function detectFormTags(content: string): DetectedFormTag[] {
  if (!content.includes('<form')) return [];

  const doc = new DOMParser().parseFromString(content, 'text/html');

  return Array.from(doc.querySelectorAll('form')).map((formElement) => {
    const domId = formElement.getAttribute('id') || '';
    const wiredMatch = domId.match(WIRED_ID_PATTERN);

    return {
      outerHtml: formElement.outerHTML,
      fields: deriveFields(formElement),
      wiredFormTargetId: wiredMatch ? wiredMatch[1] : undefined,
    };
  });
}
