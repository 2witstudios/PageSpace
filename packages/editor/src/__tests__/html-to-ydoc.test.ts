/**
 * The inbound half: stored `pages.content` HTML into the CRDT.
 *
 * Seeding is the one irreversible step in the whole design. Once a document is
 * seeded and a collaborator connects, the Y.Doc IS the document — a construct
 * lost on the way in is lost permanently, and `pages.content` is overwritten by
 * the projection of the lossy result on the next flush. So this path fails
 * closed: it throws rather than seed a document it could not fully represent.
 */
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { htmlToPmDoc, htmlToYDoc, describeHtmlLoss } from '../html-to-ydoc.js';
import { yDocToHtml } from '../y-doc-to-html.js';
import { yDocToText } from '../y-doc-to-text.js';
import { COLLAB_FRAGMENT_FIELD } from '../collab-document.js';
import { UnrepresentableContentError } from '../projection-errors.js';

describe('htmlToYDoc', () => {
  it('seeds the body under the field the client editor reads', () => {
    // `@tiptap/extension-collaboration` defaults to `field: 'default'`. Seed
    // under any other name and the editor opens an empty document over a Y.Doc
    // that is full — silently, with no error anywhere.
    const yDoc = htmlToYDoc('<p>seeded</p>');
    expect(COLLAB_FRAGMENT_FIELD).toBe('default');
    expect(yDoc.getXmlFragment('default').length).toBe(1);
    expect(yDocToText(yDoc)).toBe('seeded');
  });

  it('produces a Y.Doc that another replica converges on from its update alone', () => {
    const source = htmlToYDoc('<h2>Title</h2><p>body</p>');
    const replica = new Y.Doc();
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(source));
    expect(yDocToHtml(replica)).toBe(yDocToHtml(source));
  });

  it('drops script and style without calling them lost content', () => {
    const html = '<p>keep</p><script>var a = 1;</script><style>.a { color: red }</style>';
    expect(describeHtmlLoss(html)).toEqual([]);
    expect(yDocToText(htmlToYDoc(html))).toBe('keep');
  });
});

describe('fail closed on unrepresentable content', () => {
  it.each([
    ['an <img> with no data-file-id', '<p>a</p><img src="https://x.test/y.png" alt="pic">', 'img'],
    ['an <iframe>', '<iframe src="https://x.test"></iframe>', 'iframe'],
    ['a <video>', '<video src="v.mp4"></video>', 'video'],
    ['an <svg>', '<svg><circle /></svg>', 'svg'],
  ])('refuses to seed %s', (_name, html, tag) => {
    expect(() => htmlToPmDoc(html)).toThrow(UnrepresentableContentError);
    expect(describeHtmlLoss(html)).toEqual([`dropped 1 <${tag}> element(s)`]);
  });

  it('refuses to seed when visible text would change', () => {
    // A page mention whose only text is the `@` sigil: `label` falls back to
    // the element's text with one leading `@` stripped, which leaves nothing,
    // and the text projection then contributes nothing for it.
    const html = '<p><a class="mention" data-mention-type="page" data-page-id="p1">@</a></p>';
    expect(() => htmlToPmDoc(html)).toThrow(UnrepresentableContentError);
    expect(describeHtmlLoss(html)).toEqual(['visible text changed (1 characters in, 0 out)']);
  });

  it('never puts the offending markup or prose in the error', () => {
    // These run over production user content and land in logs and Sentry.
    const secret = 'Quarterly Revenue Projections';
    const html = `<p>${secret}</p><iframe src="https://x.test/${secret}"></iframe>`;
    try {
      htmlToPmDoc(html);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(UnrepresentableContentError);
      expect((error as Error).message).not.toContain(secret);
      // The element NAME is reported (it is the diagnosis); the attribute
      // values and the surrounding prose are not.
      expect((error as Error).message).not.toContain('src=');
      expect((error as Error).message).not.toContain('https://');
      expect((error as UnrepresentableContentError).reasons).toEqual([
        'dropped 1 <iframe> element(s)',
      ]);
    }
  });

  it('reports every reason at once rather than stopping at the first', () => {
    // A bulk seed needs the whole verdict on a document in one pass, not a
    // page-at-a-time game of whack-a-mole.
    expect(
      describeHtmlLoss('<img src="a.png"><iframe src="b"></iframe>').sort(),
    ).toEqual(['dropped 1 <iframe> element(s)', 'dropped 1 <img> element(s)']);
  });

  it('counts multiple drops of the same element', () => {
    expect(describeHtmlLoss('<img src="a.png"><img src="b.png">')).toEqual([
      'dropped 2 <img> element(s)',
    ]);
  });

  it('does not report a trailing <br>, which is caret padding rather than content', () => {
    // Browsers emit these; counting them would report a loss on markup that
    // lost nothing, and a false alarm on the seed path is a blocked migration.
    expect(describeHtmlLoss('<p>a</p><br><br>')).toEqual([]);
  });

  it('keeps an <img> that DOES carry a file id', () => {
    expect(describeHtmlLoss('<img data-file-id="file_1" alt="ok">')).toEqual([]);
    expect(() => htmlToPmDoc('<img data-file-id="file_1" alt="ok">')).not.toThrow();
  });
});
