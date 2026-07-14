import { describe, it, expect } from 'vitest';
import type { FileUIPart } from 'ai';
import { buildUserMessage } from '../buildUserMessage';

describe('buildUserMessage', () => {
  it('given only an id, should produce a user message with empty parts', () => {
    const msg = buildUserMessage({ id: 'u1' });
    expect(msg).toEqual({ id: 'u1', role: 'user', parts: [] });
  });

  it('given text, should produce a single text part', () => {
    const msg = buildUserMessage({ id: 'u1', text: 'hello' });
    expect(msg.parts).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('given an empty string text, should still produce a text part (only null/undefined text is omitted)', () => {
    const msg = buildUserMessage({ id: 'u1', text: '' });
    expect(msg.parts).toEqual([{ type: 'text', text: '' }]);
  });

  it('given files, should pass them through as-is ahead of the text part', () => {
    const files: FileUIPart[] = [{ type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,abc' }];
    const msg = buildUserMessage({ id: 'u1', text: 'caption', files });
    expect(msg.parts).toEqual([files[0], { type: 'text', text: 'caption' }]);
  });

  it('given files and no text, should produce only the file parts', () => {
    const files: FileUIPart[] = [{ type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,abc' }];
    const msg = buildUserMessage({ id: 'u1', files });
    expect(msg.parts).toEqual(files);
  });

  it('given metadata, should attach it', () => {
    const msg = buildUserMessage({ id: 'u1', text: 'hi', metadata: { source: 'sidebar' } });
    expect(msg.metadata).toEqual({ source: 'sidebar' });
  });

  it('given no metadata, should omit the metadata key entirely', () => {
    const msg = buildUserMessage({ id: 'u1', text: 'hi' });
    expect('metadata' in msg).toBe(false);
  });

  it('given a caller id, should carry it through unchanged', () => {
    const msg = buildUserMessage({ id: 'client-minted-id', text: 'hi' });
    expect(msg.id).toBe('client-minted-id');
    expect(msg.role).toBe('user');
  });

  it('given a files array, should not mutate it', () => {
    const files: FileUIPart[] = [{ type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,abc' }];
    const originalLength = files.length;
    buildUserMessage({ id: 'u1', text: 'hi', files });
    expect(files).toHaveLength(originalLength);
  });
});
