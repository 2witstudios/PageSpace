import { describe, it, expect } from 'vitest';
import {
  decideConflictOutcome,
  planConflictResolution,
  canScheduleSave,
  readContent,
  type DocumentConflict,
} from '../conflict-resolution';

describe('readContent', () => {
  it('given undefined, should report the content as absent', () => {
    expect(readContent(undefined)).toEqual({ present: false });
  });

  it('given null, should report an explicitly empty document', () => {
    expect(readContent(null)).toEqual({ present: true, content: '' });
  });

  it('given a string, should report it present', () => {
    expect(readContent('text')).toEqual({ present: true, content: 'text' });
  });

  it('given an empty string, should report it present rather than absent', () => {
    expect(readContent('')).toEqual({ present: true, content: '' });
  });
});

describe('decideConflictOutcome', () => {
  it('given a refetched remote page with a revision, should park it as a conflict', () => {
    const outcome = decideConflictOutcome({
      conflictBody: { error: 'Page was modified', currentRevision: 4, expectedRevision: 3 },
      remotePage: { content: 'their text', revision: 4 },
      detectedAt: 1000,
    });

    expect(outcome).toEqual({
      kind: 'conflict',
      conflict: { remoteContent: 'their text', remoteRevision: 4, detectedAt: 1000 },
    });
  });

  it('given a remote page with null content, should treat it as an empty remote document', () => {
    const outcome = decideConflictOutcome({
      conflictBody: { currentRevision: 9 },
      remotePage: { content: null, revision: 9 },
      detectedAt: 5,
    });

    expect(outcome).toEqual({
      kind: 'conflict',
      conflict: { remoteContent: '', remoteRevision: 9, detectedAt: 5 },
    });
  });

  it('given a remote page with an absent content field, should error rather than offer an empty document', () => {
    // Coercing absent content to '' would let "Use theirs" wipe the local text.
    const outcome = decideConflictOutcome({
      conflictBody: { currentRevision: 4 },
      remotePage: { revision: 4 },
      detectedAt: 1000,
    });

    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') throw new Error('expected error');
    expect(outcome.message).toContain('still here');
  });

  it('given a remote page without a revision, should fall back to currentRevision from the 409 body', () => {
    const outcome = decideConflictOutcome({
      conflictBody: { currentRevision: 7, expectedRevision: 6 },
      remotePage: { content: 'their text' },
      detectedAt: 2,
    });

    expect(outcome).toEqual({
      kind: 'conflict',
      conflict: { remoteContent: 'their text', remoteRevision: 7, detectedAt: 2 },
    });
  });

  it('given the refetch failed, should return an error rather than a conflict', () => {
    const outcome = decideConflictOutcome({
      conflictBody: { currentRevision: 4 },
      remotePage: null,
      detectedAt: 1000,
    });

    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') throw new Error('expected error');
    expect(outcome.message).toContain('still here');
  });

  it('given no revision is recoverable from either source, should return an error', () => {
    const outcome = decideConflictOutcome({
      conflictBody: { error: 'Page was modified' },
      remotePage: { content: 'their text' },
      detectedAt: 1000,
    });

    expect(outcome.kind).toBe('error');
  });

  it('given a missing 409 body, should still park a conflict when the remote page carries a revision', () => {
    const outcome = decideConflictOutcome({
      conflictBody: null,
      remotePage: { content: 'their text', revision: 12 },
      detectedAt: 3,
    });

    expect(outcome).toEqual({
      kind: 'conflict',
      conflict: { remoteContent: 'their text', remoteRevision: 12, detectedAt: 3 },
    });
  });
});

describe('planConflictResolution', () => {
  const conflict: DocumentConflict = {
    remoteContent: 'their text',
    remoteRevision: 11,
    detectedAt: 1,
  };

  it('given keep-mine, should save the local content against the remote revision', () => {
    expect(planConflictResolution('keep-mine', { localContent: 'my text', conflict })).toEqual({
      action: 'save-local',
      contentToSave: 'my text',
      expectedRevision: 11,
    });
  });

  it('given use-theirs, should adopt the remote content and revision', () => {
    expect(planConflictResolution('use-theirs', { localContent: 'my text', conflict })).toEqual({
      action: 'adopt-remote',
      contentToAdopt: 'their text',
      revision: 11,
    });
  });
});

describe('canScheduleSave', () => {
  it('given no pending conflict, should allow the save', () => {
    expect(canScheduleSave({ hasPendingConflict: false })).toBe(true);
  });

  it('given a pending conflict, should block the save so the autosave loop cannot re-409', () => {
    expect(canScheduleSave({ hasPendingConflict: true })).toBe(false);
  });
});
