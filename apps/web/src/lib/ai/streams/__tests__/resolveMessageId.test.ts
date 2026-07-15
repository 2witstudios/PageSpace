import { describe, it, expect } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { resolveMessageId } from '../resolveMessageId';

describe('resolveMessageId', () => {
  it('given a well-formed client cuid, honors it', () => {
    const clientId = createId();
    expect(resolveMessageId(clientId)).toBe(clientId);
  });

  it('given undefined, mints a fresh cuid', () => {
    const result = resolveMessageId(undefined);
    expect(result).not.toBeUndefined();
    expect(result.length).toBeGreaterThan(0);
  });

  it('given null, mints a fresh cuid', () => {
    const result = resolveMessageId(null);
    expect(result).not.toBeNull();
    expect(result.length).toBeGreaterThan(0);
  });

  it('given an empty string, mints a fresh cuid rather than persisting under an empty id', () => {
    const result = resolveMessageId('');
    expect(result).not.toBe('');
    expect(result.length).toBeGreaterThan(0);
  });

  it('given a malformed id containing unsafe characters, mints a fresh id instead of trusting it', () => {
    const malformed = "'; DROP TABLE chat_messages; --";
    const result = resolveMessageId(malformed);
    expect(result).not.toBe(malformed);
  });

  it('given a path-traversal-shaped id, mints a fresh id rather than letting it reach a URL path segment', () => {
    const malformed = '../../../etc/passwd';
    const result = resolveMessageId(malformed);
    expect(result).not.toBe(malformed);
  });

  it('given an id longer than 128 characters, mints a fresh id', () => {
    const tooLong = 'a'.repeat(129);
    const result = resolveMessageId(tooLong);
    expect(result).not.toBe(tooLong);
  });

  // Regression pin (PR review, chatgpt-codex-connector): the AI SDK's default
  // `generateId` (used by every sender still on the `sendMessage({ text, files })`
  // shorthand — GlobalAssistantView, SidebarChatTab) produces a 16-char id from a
  // MIXED-CASE alphabet (0-9A-Za-z), which fails `isCuid`'s lowercase-only regex.
  // An earlier version of this function required isCuid and rejected these,
  // splitting the id useChat's local state used from the one actually persisted.
  it('given the AI SDK default generator\'s mixed-case, non-cuid id shape, honors it (not cuid-specific)', () => {
    const sdkDefaultShapedId = 'Ab3xQ9zK2mNp7RtY'; // 16 chars, mixed case — never a valid cuid2
    expect(resolveMessageId(sdkDefaultShapedId)).toBe(sdkDefaultShapedId);
  });

  it('given an id with underscores and hyphens (a common non-cuid id convention), honors it', () => {
    const id = 'msg_2024-01-01_abc123';
    expect(resolveMessageId(id)).toBe(id);
  });
});
