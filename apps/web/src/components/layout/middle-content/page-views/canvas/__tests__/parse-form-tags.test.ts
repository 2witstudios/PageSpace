import { describe, it, expect } from 'vitest';
import { detectFormTags } from '../parse-form-tags';

describe('detectFormTags', () => {
  it('returns an empty array when content has no <form> tags', () => {
    expect(detectFormTags('<h1>No forms here</h1>')).toEqual([]);
  });

  it('detects a bare, unwired <form> tag and derives its fields', () => {
    const content = `
      <form>
        <label>Email <input name="email" type="email" required></label>
        <label>Comments <textarea name="comments"></textarea></label>
        <button type="submit">Submit</button>
      </form>
    `;

    const [detected] = detectFormTags(content);

    expect(detected.wiredFormTargetId).toBeUndefined();
    expect(detected.fields).toEqual([
      { name: 'email', label: 'Email', type: 'email', required: true },
      { name: 'comments', label: 'Comments', type: 'textarea', required: false },
    ]);
  });

  it('humanizes underscore/hyphen field names into a label', () => {
    const content = '<form><input name="first_name"><input name="last-name"></form>';
    const [detected] = detectFormTags(content);

    expect(detected.fields.map((f) => f.label)).toEqual(['First Name', 'Last Name']);
  });

  it('excludes the honeypot field, submit/hidden/button inputs, and duplicate names', () => {
    const content = `
      <form>
        <input name="email">
        <input name="_hp" type="text">
        <input type="hidden" name="csrf" value="x">
        <input type="submit" value="Go">
        <input name="email">
      </form>
    `;
    const [detected] = detectFormTags(content);

    expect(detected.fields).toEqual([{ name: 'email', label: 'Email', type: 'text', required: false }]);
  });

  it('recognizes a form as already wired via its pagespace-form-{id} DOM id', () => {
    const content = '<form id="pagespace-form-ft-123"><input name="email"></form>';
    const [detected] = detectFormTags(content);

    expect(detected.wiredFormTargetId).toBe('ft-123');
  });

  it('treats a form with an unrelated id as unwired', () => {
    const content = '<form id="my-waitlist-form"><input name="email"></form>';
    const [detected] = detectFormTags(content);

    expect(detected.wiredFormTargetId).toBeUndefined();
  });

  it('detects multiple independent forms on the same page', () => {
    const content = `
      <form id="pagespace-form-ft-a"><input name="email"></form>
      <form><input name="message"></form>
    `;
    const detected = detectFormTags(content);

    expect(detected).toHaveLength(2);
    expect(detected[0].wiredFormTargetId).toBe('ft-a');
    expect(detected[1].wiredFormTargetId).toBeUndefined();
  });

  it('treats a checkbox input as type checkbox', () => {
    const content = '<form><input name="subscribe" type="checkbox"></form>';
    const [detected] = detectFormTags(content);

    expect(detected.fields).toEqual([{ name: 'subscribe', label: 'Subscribe', type: 'checkbox', required: false }]);
  });
});
