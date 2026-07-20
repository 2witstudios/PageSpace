import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import {
  validateWebhookEnvelope,
  validateChannelWebhookPayload,
  resolveWebhookHandler,
  formatWebhookSenderIdentity,
  WEBHOOK_HANDLER_PAGE_TYPES,
  WEBHOOK_CONTENT_MAX_LENGTH,
  WEBHOOK_USERNAME_MAX_LENGTH,
} from '../page-webhook-core';

describe('validateWebhookEnvelope', () => {
  it('accepts any JSON object, whatever its keys — the envelope is arbitrary JSON', () => {
    for (const envelope of [{}, { content: 'hi' }, { anything: [1, 2, { nested: true }] }, { ref: null }]) {
      expect(validateWebhookEnvelope(envelope)).toEqual({ ok: true, envelope });
    }
  });

  it('rejects every non-object body with the same envelope error', () => {
    for (const raw of [null, undefined, 'string', 42, true, []]) {
      expect(validateWebhookEnvelope(raw)).toEqual({ ok: false, error: 'payload must be a JSON object' });
    }
  });
});

describe('resolveWebhookHandler', () => {
  it('resolves CHANNEL to the CHANNEL handler key', () => {
    expect(resolveWebhookHandler('CHANNEL')).toBe('CHANNEL');
  });

  it('resolves every page type without a default action to none', () => {
    for (const type of ['DOCUMENT', 'FOLDER', 'AI_CHAT', 'CANVAS', 'FILE', 'SHEET', 'TASK_LIST', 'CODE', 'MACHINE']) {
      expect(resolveWebhookHandler(type)).toBe('none');
    }
  });

  it('resolves a missing or unknown page type to none, never a throw', () => {
    expect(resolveWebhookHandler(undefined)).toBe('none');
    expect(resolveWebhookHandler(null)).toBe('none');
    expect(resolveWebhookHandler('NOT_A_PAGE_TYPE')).toBe('none');
  });

  it('resolves exactly the registered handler page types — the tuple is the decision', () => {
    for (const type of WEBHOOK_HANDLER_PAGE_TYPES) {
      expect(resolveWebhookHandler(type)).toBe(type);
    }
  });
});

describe('validateChannelWebhookPayload', () => {
  it('accepts a minimal valid payload and returns its content verbatim', () => {
    const result = validateChannelWebhookPayload({ content: 'deploy finished ✅' });
    expect(result).toEqual({ ok: true, content: 'deploy finished ✅', username: undefined });
  });

  it('accepts a username override and passes it through', () => {
    const result = validateChannelWebhookPayload({ content: 'hi', username: 'CI Bot' });
    expect(result).toEqual({ ok: true, content: 'hi', username: 'CI Bot' });
  });

  it('preserves surrounding whitespace in content — the message posts verbatim', () => {
    const result = validateChannelWebhookPayload({ content: '  padded  ' });
    expect(result).toEqual({ ok: true, content: '  padded  ', username: undefined });
  });

  it('rejects a non-object payload', () => {
    for (const raw of [null, undefined, 'string', 42, true, []]) {
      const result = validateChannelWebhookPayload(raw);
      expect(result.ok).toBe(false);
    }
  });

  it('rejects a payload with no content field', () => {
    const result = validateChannelWebhookPayload({ username: 'CI Bot' });
    expect(result).toEqual({ ok: false, error: 'content is required and must be a string' });
  });

  it('rejects non-string content', () => {
    const result = validateChannelWebhookPayload({ content: 42 });
    expect(result).toEqual({ ok: false, error: 'content is required and must be a string' });
  });

  it('rejects empty content', () => {
    const result = validateChannelWebhookPayload({ content: '' });
    expect(result).toEqual({ ok: false, error: 'content must not be empty' });
  });

  it('rejects whitespace-only content', () => {
    const result = validateChannelWebhookPayload({ content: '   \n\t ' });
    expect(result).toEqual({ ok: false, error: 'content must not be empty' });
  });

  it('accepts content exactly at the length cap', () => {
    const result = validateChannelWebhookPayload({ content: 'x'.repeat(WEBHOOK_CONTENT_MAX_LENGTH) });
    expect(result.ok).toBe(true);
  });

  it('rejects content over the length cap', () => {
    const result = validateChannelWebhookPayload({ content: 'x'.repeat(WEBHOOK_CONTENT_MAX_LENGTH + 1) });
    expect(result).toEqual({ ok: false, error: `content must be at most ${WEBHOOK_CONTENT_MAX_LENGTH} characters` });
  });

  it('rejects a non-string username', () => {
    const result = validateChannelWebhookPayload({ content: 'hi', username: 42 });
    expect(result).toEqual({ ok: false, error: 'username must be a string' });
  });

  it('treats a whitespace-only username as absent — falls back to the webhook name downstream', () => {
    const result = validateChannelWebhookPayload({ content: 'hi', username: '   ' });
    expect(result).toEqual({ ok: true, content: 'hi', username: undefined });
  });

  it('rejects a username over the length cap', () => {
    const result = validateChannelWebhookPayload({ content: 'hi', username: 'x'.repeat(WEBHOOK_USERNAME_MAX_LENGTH + 1) });
    expect(result).toEqual({ ok: false, error: `username must be at most ${WEBHOOK_USERNAME_MAX_LENGTH} characters` });
  });
});

describe('formatWebhookSenderIdentity', () => {
  it('uses the payload username when given — an explicit override beats the webhook name (Discord rule)', () => {
    expect(formatWebhookSenderIdentity('CI Bot', 'Deploys')).toEqual({
      senderType: 'webhook',
      senderName: 'CI Bot',
    });
  });

  it('falls back to the webhook configured name when no username override is given', () => {
    expect(formatWebhookSenderIdentity(undefined, 'Deploys')).toEqual({
      senderType: 'webhook',
      senderName: 'Deploys',
    });
  });

  it('treats a whitespace-only username as absent', () => {
    expect(formatWebhookSenderIdentity('  ', 'Deploys')).toEqual({
      senderType: 'webhook',
      senderName: 'Deploys',
    });
  });

  it('falls back to a generic name when neither is usable', () => {
    expect(formatWebhookSenderIdentity(undefined, undefined)).toEqual({
      senderType: 'webhook',
      senderName: 'Webhook',
    });
    expect(formatWebhookSenderIdentity('', '  ')).toEqual({
      senderType: 'webhook',
      senderName: 'Webhook',
    });
  });
});

describe('page-webhook-core purity', () => {
  it('imports no db client, fetch, or clock — it is a pure decision layer', () => {
    const src = readFileSync(fileURLToPath(new URL('../page-webhook-core.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/from ['"][^'"]*\/db['"]/);
    expect(src).not.toMatch(/\bfetch\(/);
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/Date\.now/);
    expect(src).not.toMatch(/new Date\(/);
    // Only type-only imports are allowed from schema modules (erased at compile time).
    const schemaImports = src.match(/^import .*from ['"][^'"]*\/schema\/[^'"]*['"];?$/gm) ?? [];
    for (const line of schemaImports) {
      expect(line.startsWith('import type')).toBe(true);
    }
  });
});
