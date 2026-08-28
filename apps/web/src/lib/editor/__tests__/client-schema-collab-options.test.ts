/**
 * Regression tests for two review findings on `clientExtensions()`
 * (PR #2515): `undoRedo: false` was unconditional, silently removing Cmd-Z
 * from every non-collaborative `RichEditor` (documents without `collab`, and
 * every task-description surface); `CollaborationCaret` was configured
 * whenever `collab` was set even without a `provider`, and it throws in
 * `onCreate` without one.
 */
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { clientExtensions } from '../client-schema';
import { STARTER_KIT_SCHEMA_OPTIONS } from '../collab-schema';

function starterKitOptions(extensions: ReturnType<typeof clientExtensions>): { undoRedo?: unknown; heading?: unknown; link?: unknown; codeBlock?: unknown } {
  const starterKit = extensions.find((ext) => ext.name === 'starterKit');
  if (!starterKit) {
    throw new Error('starterKit extension not found in clientExtensions() output');
  }
  return starterKit.options as { undoRedo?: unknown; heading?: unknown; link?: unknown; codeBlock?: unknown };
}

describe('clientExtensions(): StarterKit schema options come from the shared constant', () => {
  // Review finding: client-schema.ts and collab-schema.ts each hardcoded an
  // identical StarterKit.configure({ heading, link, codeBlock }) block. A
  // Class-C-only change (e.g. link.openOnClick) doesn't move SCHEMA_HASH, so
  // the drift guard wouldn't catch the two files silently disagreeing.
  it('heading/link/codeBlock exactly match STARTER_KIT_SCHEMA_OPTIONS', () => {
    const options = starterKitOptions(clientExtensions({ readOnly: false, isPaginated: false }));
    expect(options.heading).toEqual(STARTER_KIT_SCHEMA_OPTIONS.heading);
    expect(options.link).toEqual(STARTER_KIT_SCHEMA_OPTIONS.link);
    expect(options.codeBlock).toBe(STARTER_KIT_SCHEMA_OPTIONS.codeBlock);
  });
});

describe('clientExtensions(): undoRedo only disabled when collab is mounted', () => {
  it('keeps native undo/redo enabled without collab', () => {
    const extensions = clientExtensions({ readOnly: false, isPaginated: false });
    expect(starterKitOptions(extensions).undoRedo).not.toBe(false);
  });

  it('keeps native undo/redo enabled for a read-only, non-collab editor too', () => {
    const extensions = clientExtensions({ readOnly: true, isPaginated: false });
    expect(starterKitOptions(extensions).undoRedo).not.toBe(false);
  });

  it('disables native undo/redo when collab is mounted', () => {
    const extensions = clientExtensions({
      readOnly: false,
      isPaginated: false,
      collab: { document: new Y.Doc() },
    });
    expect(starterKitOptions(extensions).undoRedo).toBe(false);
  });
});

describe('clientExtensions(): CollaborationCaret requires a provider', () => {
  it('mounts Collaboration without CollaborationCaret when collab has no provider', () => {
    const extensions = clientExtensions({
      readOnly: false,
      isPaginated: false,
      collab: { document: new Y.Doc() },
    });
    expect(extensions.some((ext) => ext.name === 'collaboration')).toBe(true);
    expect(extensions.some((ext) => ext.name === 'collaborationCaret')).toBe(false);
  });

  it('mounts CollaborationCaret when collab has a provider', () => {
    const extensions = clientExtensions({
      readOnly: false,
      isPaginated: false,
      collab: { document: new Y.Doc(), provider: {} },
    });
    expect(extensions.some((ext) => ext.name === 'collaborationCaret')).toBe(true);
  });

  it('does not mount Collaboration or CollaborationCaret without collab', () => {
    const extensions = clientExtensions({ readOnly: false, isPaginated: false });
    expect(extensions.some((ext) => ext.name === 'collaboration')).toBe(false);
    expect(extensions.some((ext) => ext.name === 'collaborationCaret')).toBe(false);
  });
});
