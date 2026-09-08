import { DOMSerializer, type Node as PmNode } from 'prosemirror-model';
import type * as Y from 'yjs';
import { collabSchema, yDocToPmDoc } from './collab-document.js';
import { withDomWorkspace } from './dom-workspace.js';
import { assertProjectable } from './projection-errors.js';

/**
 * The HTML projection — what `pages.content` keeps holding, forever.
 *
 * This is the projection every existing consumer already reads: export,
 * publish and canvas render, `syncMentions` (which parses mentions back out of
 * this markup), drive backups, `scripts/tenant-export.ts`, and the
 * human-readable recovery artifact if a `Y.Doc` is ever corrupted. It is the
 * lossless one: the other three projections may drop formatting they cannot
 * express, this one may not.
 *
 * Rendered through `DOMSerializer` against the frozen schema, into a detached
 * happy-dom element — never through `@tiptap/html`'s `generateHTML`, which
 * calls `document.implementation.createHTMLDocument()` on a *global*
 * `document` this package refuses to install.
 */
export function yDocToHtml(yDoc: Y.Doc): string {
  return pmDocToHtml(yDocToPmDoc(yDoc));
}

/**
 * The frozen schema's own names — the HTML projection can represent exactly
 * what the schema describes, no more and no less. Memoised for the same reason
 * the schema is: this runs on every flush.
 *
 * The check is NOT redundant with `DOMSerializer`. `DOMSerializer.fromSchema`
 * builds its node map from the schema the *document* was created against, so a
 * node from a foreign schema serializes through whatever `toDOM` that schema
 * gave it, or silently yields nothing — the projection gets written either way
 * and the loss is invisible. Checking names against the FROZEN schema up front
 * is what turns that into a throw.
 */
let cachedNames: { nodes: ReadonlySet<string>; marks: ReadonlySet<string> } | undefined;

function projectableNames(): { nodes: ReadonlySet<string>; marks: ReadonlySet<string> } {
  const schema = collabSchema();
  cachedNames ??= {
    nodes: new Set(Object.keys(schema.nodes)),
    marks: new Set(Object.keys(schema.marks)),
  };
  return cachedNames;
}

/** `yDocToHtml` over an already-materialised ProseMirror document. */
export function pmDocToHtml(doc: PmNode): string {
  const known = projectableNames();
  assertProjectable(doc, 'html', known.nodes, known.marks);
  return withDomWorkspace((workspace) => {
    const target = workspace.empty();
    DOMSerializer.fromSchema(collabSchema()).serializeFragment(
      doc.content,
      { document: workspace.document },
      target,
    );
    return target.innerHTML;
  });
}
