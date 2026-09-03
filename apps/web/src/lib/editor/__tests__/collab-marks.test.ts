/**
 * Regression test for a CodeRabbit finding on PR #2515: ProseMirror's
 * `MarkSpec.excludes` defaults to "exclusive with marks of the same type"
 * (unset), so applying a second `comment` mark over text already covered
 * by one would replace or reject the first, keyed only on mark name — not
 * `threadId`. Comment threads commonly overlap; `CommentMark` sets
 * `excludes: ''` so multiple `comment` marks coexist.
 */
import { describe, it, expect } from 'vitest';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { CommentMark } from '../collab-marks';

describe('CommentMark allows overlapping threads', () => {
  it('two comment marks with different threadId can both be added to the same set', () => {
    const schema = getSchema([StarterKit, CommentMark]);
    const markA = schema.marks.comment.create({ threadId: 'thread-a' });
    const markB = schema.marks.comment.create({ threadId: 'thread-b' });

    const setWithA = markA.addToSet([]);
    const setWithBoth = markB.addToSet(setWithA);

    expect(setWithBoth).toHaveLength(2);
    expect(setWithBoth.some((m) => m.attrs.threadId === 'thread-a')).toBe(true);
    expect(setWithBoth.some((m) => m.attrs.threadId === 'thread-b')).toBe(true);
  });
});
