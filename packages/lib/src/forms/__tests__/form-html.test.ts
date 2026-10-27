import { describe, it, expect } from 'vitest';
import { buildFormHtml, wireFormBlock } from '../form-html';
import { HONEYPOT_FIELD_NAME } from '../honeypot';
import type { FormFieldDef } from '@pagespace/db/schema/form-targets';

const fields: FormFieldDef[] = [
  { name: 'name', label: 'Name', type: 'text', required: true },
  { name: 'email', label: 'Email', type: 'email', required: true },
  { name: 'notes', label: 'Anything else?', type: 'textarea', required: false },
];

describe('buildFormHtml', () => {
  it('emits an input for every field with the correct name, type, and label', () => {
    const html = buildFormHtml({ fields, submitUrl: 'https://app.pagespace.ai/api/public/forms/tok_abc/submit' });

    expect(html).toContain('name="name"');
    expect(html).toContain('type="text"');
    expect(html).toContain('name="email"');
    expect(html).toContain('type="email"');
    expect(html).toContain('name="notes"');
    expect(html).toContain('<textarea');
    expect(html).toContain('Name');
    expect(html).toContain('Email');
    expect(html).toContain('Anything else?');
  });

  it('marks required fields as required and leaves optional fields unmarked', () => {
    const html = buildFormHtml({ fields, submitUrl: 'https://app.pagespace.ai/api/public/forms/tok_abc/submit' });
    const nameInputMatch = html.match(/<input[^>]*name="name"[^>]*>/)?.[0] ?? '';
    const notesMatch = html.match(/<textarea[^>]*name="notes"[^>]*>/)?.[0] ?? '';

    expect(nameInputMatch).toContain('required');
    expect(notesMatch).not.toContain('required');
  });

  it('includes a hidden honeypot input that is visually hidden, not merely present', () => {
    const html = buildFormHtml({ fields, submitUrl: 'https://app.pagespace.ai/api/public/forms/tok_abc/submit' });
    const honeypotMatch = html.match(new RegExp(`<input[^>]*name="${HONEYPOT_FIELD_NAME}"[^>]*>`))?.[0] ?? '';

    expect(honeypotMatch).not.toBe('');
    expect(honeypotMatch).toMatch(/tabindex="-1"|autocomplete="off"/);
    expect(html).toContain('position:absolute');
  });

  it('embeds the exact submit URL passed in', () => {
    const html = buildFormHtml({ fields, submitUrl: 'https://app.pagespace.ai/api/public/forms/tok_xyz/submit' });
    expect(html).toContain('https://app.pagespace.ai/api/public/forms/tok_xyz/submit');
  });

  it('HTML-escapes a field label containing markup', () => {
    const maliciousFields: FormFieldDef[] = [
      { name: 'name', label: '<script>alert(1)</script>', type: 'text', required: true },
    ];
    const html = buildFormHtml({ fields: maliciousFields, submitUrl: 'https://app.pagespace.ai/api/public/forms/tok/submit' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('preserves a submitUrl containing an ampersand and quotes intact in the JS fetch() call, not HTML-escaped', () => {
    const submitUrl = 'https://app.pagespace.ai/api/public/forms/tok/submit?a=1&b="two"';
    const html = buildFormHtml({ fields, submitUrl });

    // The script body must fetch() the exact raw URL — an HTML-escaped
    // "&amp;"/"&quot;" in a JS string context would corrupt the request.
    expect(html).toContain(JSON.stringify(submitUrl).replace(/</g, '\\u003c'));
    expect(html).not.toContain('&amp;b=');
  });

  it('does not let a formId containing "</script>" break out of the inline script block', () => {
    const html = buildFormHtml({
      fields,
      submitUrl: 'https://app.pagespace.ai/api/public/forms/tok/submit',
      formId: '</script><script>alert(1)</script>',
    });

    expect(html).not.toContain('</script><script>alert(1)</script>');
  });
});

describe('wireFormBlock', () => {
  const submitUrl = 'https://app.pagespace.ai/api/public/forms/tok_abc/submit';

  it('preserves the original inputs untouched', () => {
    const result = wireFormBlock({
      formOuterHtml: '<form class="hero"><input name="email" type="email" required></form>',
      formTargetId: 'ft-1',
      submitUrl,
    });

    expect(result).toContain('<input name="email" type="email" required>');
    expect(result).toContain('class="hero"');
  });

  it('assigns a deterministic id derived from the form target id', () => {
    const result = wireFormBlock({
      formOuterHtml: '<form><input name="email"></form>',
      formTargetId: 'ft-1',
      submitUrl,
    });

    expect(result).toContain('id="pagespace-form-ft-1"');
  });

  it('replaces a pre-existing id rather than duplicating the attribute', () => {
    const result = wireFormBlock({
      formOuterHtml: '<form id="my-waitlist-form"><input name="email"></form>',
      formTargetId: 'ft-1',
      submitUrl,
    });

    expect(result).toContain('id="pagespace-form-ft-1"');
    expect(result).not.toContain('my-waitlist-form');
    expect(result.match(/\bid=/g)?.length).toBe(1);
  });

  it('injects a hidden honeypot input before the closing tag', () => {
    const result = wireFormBlock({
      formOuterHtml: '<form><input name="email"></form>',
      formTargetId: 'ft-1',
      submitUrl,
    });
    const honeypotMatch = result.match(new RegExp(`<input[^>]*name="${HONEYPOT_FIELD_NAME}"[^>]*>`))?.[0] ?? '';

    expect(honeypotMatch).not.toBe('');
    expect(result.indexOf(honeypotMatch)).toBeLessThan(result.indexOf('</form>'));
  });

  it('appends a submit script targeting the assigned id and the exact submit URL', () => {
    const result = wireFormBlock({
      formOuterHtml: '<form><input name="email"></form>',
      formTargetId: 'ft-1',
      submitUrl,
    });

    expect(result).toContain('<script>');
    expect(result).toContain(JSON.stringify('pagespace-form-ft-1'));
    expect(result).toContain(JSON.stringify(submitUrl));
  });

  it('guards status-element lookup since a hand-authored form has no [data-role="form-status"]', () => {
    const result = wireFormBlock({
      formOuterHtml: '<form><input name="email"></form>',
      formTargetId: 'ft-1',
      submitUrl,
    });

    expect(result).toContain('if (status)');
  });
});
