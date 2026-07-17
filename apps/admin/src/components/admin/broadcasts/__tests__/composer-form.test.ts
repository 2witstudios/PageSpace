import { describe, it, expect } from 'vitest';
import {
  EMPTY_AUDIENCE,
  EMPTY_COMPOSER_FORM,
  buildAudienceDefinition,
  buildCreatePayload,
  formatServerFailureMessage,
  formSnapshot,
  isPreviewStale,
  type ComposerFormState,
} from '../composer-form';

describe('buildAudienceDefinition', () => {
  it('drops every untouched field so an empty builder targets everyone', () => {
    expect(buildAudienceDefinition(EMPTY_AUDIENCE)).toEqual({});
  });

  it('includes only the fields the admin actually set', () => {
    const def = buildAudienceDefinition({
      includeUnverified: true,
      planTiers: ['pro', 'founder'],
      signupAfter: '2026-01-01',
      signupBefore: '',
      userIds: ['u1'],
    });
    expect(def.includeUnverified).toBe(true);
    expect(def.planTiers).toEqual(['pro', 'founder']);
    expect(def.signupAfter).toBe('2026-01-01T00:00:00.000Z');
    expect(def.signupBefore).toBeUndefined();
    expect(def.userIds).toEqual(['u1']);
  });

  it('bounds signupBefore to end-of-day so the inclusive date reads as intended', () => {
    const def = buildAudienceDefinition({ ...EMPTY_AUDIENCE, signupBefore: '2026-01-31' });
    expect(def.signupBefore).toBe('2026-01-31T23:59:59.999Z');
  });
});

describe('buildCreatePayload', () => {
  const composeForm: ComposerFormState = {
    ...EMPTY_COMPOSER_FORM,
    contentMode: 'compose',
    subject: 'Hello',
    bodyMarkdown: 'World',
    templateId: 'stale-template-id',
  };

  it('drops the cross-mode templateId when composing', () => {
    const payload = buildCreatePayload(composeForm, true);
    expect(payload.contentMode).toBe('compose');
    expect(payload.bodyMarkdown).toBe('World');
    expect(payload.templateId).toBeUndefined();
  });

  it('drops the cross-mode bodyMarkdown when using a template', () => {
    const templateForm: ComposerFormState = {
      ...EMPTY_COMPOSER_FORM,
      contentMode: 'template',
      bodyMarkdown: 'stale draft text',
      templateId: 'tpl_1',
    };
    const payload = buildCreatePayload(templateForm, true);
    expect(payload.contentMode).toBe('template');
    expect(payload.templateId).toBe('tpl_1');
    expect(payload.bodyMarkdown).toBeUndefined();
  });

  it('always sets dryRun explicitly, never defaults it', () => {
    expect(buildCreatePayload(composeForm, true).dryRun).toBe(true);
    expect(buildCreatePayload(composeForm, false).dryRun).toBe(false);
  });

  it('carries sendLimit/delayMs/allowDuplicate only for a live send', () => {
    const payload = buildCreatePayload(composeForm, false, { sendLimit: 5, delayMs: 250, allowDuplicate: true });
    expect(payload.sendLimit).toBe(5);
    expect(payload.delayMs).toBe(250);
    expect(payload.allowDuplicate).toBe(true);
  });

  it('trims the subject', () => {
    const payload = buildCreatePayload({ ...composeForm, subject: '  Hello  ' }, true);
    expect(payload.subject).toBe('Hello');
  });
});

describe('isPreviewStale', () => {
  const form: ComposerFormState = { ...EMPTY_COMPOSER_FORM, subject: 'A', bodyMarkdown: 'B' };

  it('is never stale before a preview has been taken', () => {
    expect(isPreviewStale(null, form)).toBe(false);
  });

  it('is not stale immediately after taking a preview of the current form', () => {
    const snapshot = formSnapshot(form);
    expect(isPreviewStale(snapshot, form)).toBe(false);
  });

  it('goes stale the moment any previewed field changes', () => {
    const snapshot = formSnapshot(form);
    const edited: ComposerFormState = { ...form, subject: 'A (edited)' };
    expect(isPreviewStale(snapshot, edited)).toBe(true);
  });

  it('goes stale on an audience-only edit', () => {
    const snapshot = formSnapshot(form);
    const edited: ComposerFormState = { ...form, audience: { ...form.audience, includeUnverified: true } };
    expect(isPreviewStale(snapshot, edited)).toBe(true);
  });

  it('goes stale on an engine change', () => {
    const snapshot = formSnapshot(form);
    const edited: ComposerFormState = { ...form, engine: 'resend_broadcast' };
    expect(isPreviewStale(snapshot, edited)).toBe(true);
  });
});

describe('formatServerFailureMessage', () => {
  it('includes the broadcastId + "retrying is safe" only when the server actually returned one', () => {
    const msg = formatServerFailureMessage({ error: 'Failed to enqueue broadcast job', broadcastId: 'b_1' }, 500);
    expect(msg).toBe('Failed to enqueue broadcast job — broadcast b_1 was marked failed; retrying is safe.');
  });

  it('does not claim a row was marked failed when the outer catch returned no broadcastId', () => {
    // The route's outer catch (e.g. broadcastRepository.create itself throwing,
    // before any row exists) returns just { error } — no broadcastId.
    const msg = formatServerFailureMessage({ error: 'Failed to create broadcast' }, 500);
    expect(msg).toBe('Failed to create broadcast');
    expect(msg).not.toContain('undefined');
    expect(msg).not.toContain('retrying is safe');
  });

  it('falls back to a generic message when the body is unparseable', () => {
    expect(formatServerFailureMessage(null, 500)).toBe('Send failed (500)');
  });

  it('falls back to a generic message when the body has no error field', () => {
    expect(formatServerFailureMessage({ broadcastId: 'b_1' }, 500)).toBe('Send failed (500)');
  });
});
