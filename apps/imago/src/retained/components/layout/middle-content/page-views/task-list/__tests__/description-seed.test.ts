import { describe, it, expect } from 'vitest';
import { resolveDescriptionSeed } from '../description-seed';

describe('resolveDescriptionSeed', () => {
  it('skips when the document is already cached', () => {
    expect(resolveDescriptionSeed({ hasCachedDocument: true, initialContent: '<p>x</p>' })).toEqual({ kind: 'skip' });
    expect(resolveDescriptionSeed({ hasCachedDocument: true, initialContent: undefined })).toEqual({ kind: 'skip' });
  });

  it('seeds from real initial content', () => {
    expect(resolveDescriptionSeed({ hasCachedDocument: false, initialContent: '<p>x</p>' })).toEqual({ kind: 'seed', content: '<p>x</p>' });
    expect(resolveDescriptionSeed({ hasCachedDocument: false, initialContent: '' })).toEqual({ kind: 'seed', content: '' });
  });

  it('fetches when no initial content is given', () => {
    expect(resolveDescriptionSeed({ hasCachedDocument: false, initialContent: undefined })).toEqual({ kind: 'fetch' });
  });

  it('fetches on null instead of seeding an empty document a save could write back', () => {
    expect(resolveDescriptionSeed({ hasCachedDocument: false, initialContent: null })).toEqual({ kind: 'fetch' });
  });
});
