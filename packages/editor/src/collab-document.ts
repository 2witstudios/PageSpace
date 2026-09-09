import { getSchema } from '@tiptap/core';
import type { Node as PmNode, Schema } from 'prosemirror-model';
import * as Y from 'yjs';
import {
  prosemirrorToYXmlFragment,
  yXmlFragmentToProseMirrorRootNode,
} from 'y-prosemirror';
import { collabExtensions } from './collab-schema.js';

/**
 * The `Y.Doc` field holding the document body.
 *
 * `'default'` is not arbitrary: it is `@tiptap/extension-collaboration`'s own
 * default `field` (`dist/index.js:86`). The client editor and every headless
 * consumer must name the same fragment or they read different documents out
 * of the same `Y.Doc` and silently disagree — so the constant lives here, next
 * to the schema it shares a compatibility surface with, rather than being
 * retyped at each call site. Note that `y-prosemirror`'s own helpers default
 * to `'prosemirror'` instead; nothing in this package relies on that default.
 */
export const COLLAB_FRAGMENT_FIELD = 'default';

let cachedSchema: Schema | undefined;

/**
 * The frozen v1 ProseMirror schema, built once per process.
 *
 * `getSchema()` from `@tiptap/core@3.23.5` is DOM-free (verified at
 * `core/dist/index.js:1745`) and therefore safe to call in a Node service —
 * unlike `generateJSON`/`generateHTML`, which reach for a global `window`.
 * Memoised because building it walks every extension's `addAttributes`/
 * `addGlobalAttributes`, and the collab service converts on every flush.
 *
 * Memoisation is safe precisely because the schema is *frozen*: it has no
 * inputs, so there is no configuration under which two callers should get
 * different schemas.
 */
export function collabSchema(): Schema {
  cachedSchema ??= getSchema(collabExtensions());
  return cachedSchema;
}

/** The body fragment of `yDoc`, under the shared field name. */
export function collabFragment(yDoc: Y.Doc): Y.XmlFragment {
  return yDoc.getXmlFragment(COLLAB_FRAGMENT_FIELD);
}

/**
 * The document currently in `yDoc`, as a ProseMirror node over the frozen
 * schema. Every projection starts here — they differ only in how they render
 * this node, never in how they read the CRDT, so a projection can never
 * disagree with another about what the document contains.
 */
export function yDocToPmDoc(yDoc: Y.Doc): PmNode {
  return yXmlFragmentToProseMirrorRootNode(collabFragment(yDoc), collabSchema());
}

/**
 * A brand-new `Y.Doc` seeded with `doc`.
 *
 * SEEDING ONLY. This is `prosemirrorToYXmlFragment`, which replaces the
 * fragment's contents wholesale; running it against a document that already
 * has collaborators destroys their history and their concurrent edits. Once a
 * document is live, the only way in is `applyPmDocToYDoc`.
 */
export function pmDocToYDoc(doc: PmNode): Y.Doc {
  const yDoc = new Y.Doc();
  prosemirrorToYXmlFragment(doc, collabFragment(yDoc));
  return yDoc;
}
