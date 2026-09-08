import { DOMSerializer, type Node as PmNode } from 'prosemirror-model';
import type * as Y from 'yjs';
import { collabSchema, yDocToPmDoc } from './collab-document.js';
import { withDomWorkspace } from './dom-workspace.js';
import { UnknownNodeError } from './projection-errors.js';

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

/** `yDocToHtml` over an already-materialised ProseMirror document. */
export function pmDocToHtml(doc: PmNode): string {
  assertProjectable(doc);
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

/**
 * `DOMSerializer.fromSchema` builds its node map from the schema the *document*
 * was created against, so a node from a foreign schema does not throw here —
 * it serializes through whatever `toDOM` that schema gave it, or silently
 * yields nothing. Either way the projection would be written and the loss
 * would be invisible, which is precisely the failure mode this package exists
 * to make impossible. Checking node names against the frozen schema up front
 * turns it into a throw.
 */
function assertProjectable(doc: PmNode): void {
  const schema = collabSchema();
  const check = (node: PmNode): void => {
    if (!Object.prototype.hasOwnProperty.call(schema.nodes, node.type.name)) {
      throw new UnknownNodeError(node.type.name, 'html');
    }
  };
  check(doc);
  doc.descendants((node) => {
    check(node);
    for (const mark of node.marks) {
      if (!Object.prototype.hasOwnProperty.call(schema.marks, mark.type.name)) {
        throw new UnknownNodeError(mark.type.name, 'html');
      }
    }
    return true;
  });
}
