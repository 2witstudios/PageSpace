/**
 * The browser half of `cross-dom-parse-equality.test.ts`. Bundled by that
 * suite with esbuild and injected into a real Chromium page, where `document`
 * is Chromium's own — the DOM the client editor actually parses against.
 *
 * It must run the SAME parse the production path runs (`html-to-ydoc.ts`'s
 * `parseIn`): `DOMParser.fromSchema(collabSchema()).parse(container)` over an
 * element whose `innerHTML` is the source. Any difference here would make the
 * comparison meaningless in the reassuring direction.
 */
import { DOMParser as PmDOMParser } from 'prosemirror-model';
import { collabSchema } from '../../collab-document.js';

declare global {
  interface Window {
    __parseHtmlToPmJson?: (html: string) => unknown;
  }
}

window.__parseHtmlToPmJson = (html: string): unknown => {
  const container = document.createElement('div');
  container.innerHTML = html;
  return PmDOMParser.fromSchema(collabSchema()).parse(container).toJSON();
};
