/**
 * `applyPmDocToYDoc` — a server-computed replacement document becoming a
 * MINIMAL CRDT diff.
 *
 * The naive implementation (clear the fragment, insert the new document) is
 * indistinguishable from this one by any assertion about the resulting
 * document: both converge on the same content. The two things that separate
 * them are the SIZE of the update and what happens to a concurrent edit — so
 * those are what this suite asserts, and a test that only compared documents
 * would go green on the implementation this exists to forbid.
 */
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { applyPmDocToYDoc } from '../apply-pm-doc-to-y-doc.js';
import { htmlToPmDoc, htmlToYDoc } from '../html-to-ydoc.js';
import { collabFragment, pmDocToYDoc } from '../collab-document.js';
import { yDocToText } from '../y-doc-to-text.js';

const PARAGRAPHS = 200;

function longDocumentHtml(changedWord = 'unchanged'): string {
  return Array.from(
    { length: PARAGRAPHS },
    (_unused, index) =>
      `<p data-block-id="blk_${index}">Paragraph ${index} carries a sentence of ordinary ` +
      `prose so the document has real length, and paragraph zero is ` +
      `${index === 0 ? changedWord : 'unchanged'} here.</p>`,
  ).join('');
}

/** Bytes an observer at `before` must receive to catch up with `yDoc`. */
function updateSizeSince(yDoc: Y.Doc, before: Uint8Array): number {
  return Y.encodeStateAsUpdate(yDoc, before).byteLength;
}

describe('minimal diff', () => {
  it('emits an update proportional to the change, not to the document', () => {
    const yDoc = htmlToYDoc(longDocumentHtml());
    const before = Y.encodeStateVector(yDoc);
    const wholeDocumentSize = Y.encodeStateAsUpdate(yDoc).byteLength;

    applyPmDocToYDoc(yDoc, htmlToPmDoc(longDocumentHtml('REPLACED')));

    const diffSize = updateSizeSince(yDoc, before);
    expect(yDocToText(yDoc)).toContain('paragraph zero is REPLACED here');
    // The changed word is ~8 bytes. A couple of hundred bytes of Yjs framing
    // is expected; a fraction of the document is not.
    expect(diffSize).toBeLessThan(500);
    expect(diffSize).toBeLessThan(wholeDocumentSize / 50);
  });

  it('is dramatically smaller than replacing the fragment wholesale', () => {
    // The comparison that gives the number above its meaning. Without it,
    // "under 500 bytes" is a magic constant nobody can re-derive; with it, the
    // test fails the moment this stops being a diff at all.
    const diffed = htmlToYDoc(longDocumentHtml());
    const replaced = htmlToYDoc(longDocumentHtml());
    const before = Y.encodeStateVector(diffed);
    const next = htmlToPmDoc(longDocumentHtml('REPLACED'));

    applyPmDocToYDoc(diffed, next);

    const naiveBefore = Y.encodeStateVector(replaced);
    replaced.transact(() => {
      const fragment = collabFragment(replaced);
      fragment.delete(0, fragment.length);
      Y.applyUpdate(replaced, Y.encodeStateAsUpdate(pmDocToYDoc(next)));
    });

    expect(updateSizeSince(diffed, before) * 20).toBeLessThan(
      updateSizeSince(replaced, naiveBefore),
    );
  });

  it('touches only the paragraph that changed', () => {
    const yDoc = htmlToYDoc('<p>alpha</p><p>beta</p><p>gamma</p>');
    const fragment = collabFragment(yDoc);
    const untouched = fragment.get(2);

    applyPmDocToYDoc(yDoc, htmlToPmDoc('<p>alpha</p><p>BETA</p><p>gamma</p>'));

    // Identity, not equality: a rewritten paragraph is a NEW Y type even when
    // its text matches, and only identity distinguishes the two.
    expect(collabFragment(yDoc).get(2)).toBe(untouched);
    expect(yDocToText(yDoc)).toBe('alpha\nBETA\ngamma');
  });
});

describe('concurrency', () => {
  it('preserves a concurrent edit in an untouched paragraph', () => {
    // Delete-all-and-reinsert tombstones every character, so a collaborator's
    // concurrent edit merges against nothing and vanishes — silently, with the
    // document still perfectly well-formed.
    const server = htmlToYDoc('<p>first</p><p>second</p><p>third</p>');
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server));

    // Server rewrites the FIRST paragraph from a computed document.
    applyPmDocToYDoc(server, htmlToPmDoc('<p>FIRST</p><p>second</p><p>third</p>'));

    // Concurrently, and in ignorance of that, the client types in the THIRD.
    const clientThird = collabFragment(client).get(2) as Y.XmlElement;
    (clientThird.get(0) as Y.XmlText).insert(0, 'edited ');

    const serverUpdate = Y.encodeStateAsUpdate(server);
    const clientUpdate = Y.encodeStateAsUpdate(client);
    Y.applyUpdate(client, serverUpdate);
    Y.applyUpdate(server, clientUpdate);

    expect(yDocToText(server)).toBe('FIRST\nsecond\nedited third');
    expect(yDocToText(client)).toBe(yDocToText(server));
  });

  it('preserves a concurrent edit inside the very paragraph it rewrites', () => {
    const server = htmlToYDoc('<p>hello world</p>');
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server));

    applyPmDocToYDoc(server, htmlToPmDoc('<p>hello there world</p>'));
    ((collabFragment(client).get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(0, 'oh ');

    Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
    Y.applyUpdate(server, Y.encodeStateAsUpdate(client));

    // Character-level merge: both edits present, and both replicas agree.
    expect(yDocToText(server)).toBe(yDocToText(client));
    expect(yDocToText(server)).toContain('oh ');
    expect(yDocToText(server)).toContain('there');
  });
});

describe('transaction origin', () => {
  it('forwards the origin so a service can recognise its own writes', () => {
    // The collab service echoes updates to every client except the one that
    // caused them; without an origin it cannot tell which that is.
    const yDoc = htmlToYDoc('<p>a</p>');
    const origins: unknown[] = [];
    yDoc.on('update', (_update: Uint8Array, origin: unknown) => origins.push(origin));

    const marker = Symbol('ai-edit');
    applyPmDocToYDoc(yDoc, htmlToPmDoc('<p>b</p>'), marker);

    expect(origins).toEqual([marker]);
  });

  it('applies the whole document change in ONE transaction', () => {
    // Several transactions would emit several updates, and a client could
    // observe the document mid-rewrite — a paragraph deleted but not yet
    // reinserted.
    const yDoc = htmlToYDoc('<p>a</p><p>b</p><p>c</p>');
    let updates = 0;
    yDoc.on('update', () => {
      updates += 1;
    });

    applyPmDocToYDoc(yDoc, htmlToPmDoc('<p>A</p><p>B</p><p>C</p>'));

    expect(updates).toBe(1);
  });
});
