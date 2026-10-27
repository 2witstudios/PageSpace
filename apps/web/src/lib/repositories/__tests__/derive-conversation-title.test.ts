/**
 * Unit tests for deriveConversationTitle.
 *
 * Pure string logic — PurePoint-style cleanup (ClaudeConversationIndex.swift:411-434,372-385):
 * strip a filler prefix, take the first non-empty line, strip a leading markdown heading, then
 * truncate to ~50 chars.
 */

import { describe, it, expect } from 'vitest';
import { deriveConversationTitle } from '../derive-conversation-title';

describe('deriveConversationTitle', () => {
  it('strips a filler prefix, takes the first line, and returns it unchanged when under the cap', () => {
    expect(deriveConversationTitle('Can you help me summarize this doc')).toBe(
      'help me summarize this doc'
    );
  });

  it('strips "Please" as a filler prefix', () => {
    expect(deriveConversationTitle('Please review this PR')).toBe('review this PR');
  });

  it('strips the "Implement the following plan:" boilerplate prefix', () => {
    expect(deriveConversationTitle('Implement the following plan: add dark mode')).toBe(
      'add dark mode'
    );
  });

  it('takes only the first non-empty line', () => {
    expect(deriveConversationTitle('\n\nFirst real line\nSecond line')).toBe('First real line');
  });

  it('strips a leading markdown heading marker', () => {
    expect(deriveConversationTitle('# Heading title')).toBe('Heading title');
  });

  it('truncates to ~50 chars with a trailing "..." when the content is cut', () => {
    const long = 'a'.repeat(80);
    const result = deriveConversationTitle(long);
    expect(result).toBe('a'.repeat(50) + '...');
  });

  it('returns content unchanged (no spurious "...") when already under the length cap', () => {
    expect(deriveConversationTitle('short message')).toBe('short message');
  });

  it('returns "" for empty content', () => {
    expect(deriveConversationTitle('')).toBe('');
  });

  it('returns "" for whitespace-only content', () => {
    expect(deriveConversationTitle('   \n\t  ')).toBe('');
  });
});
