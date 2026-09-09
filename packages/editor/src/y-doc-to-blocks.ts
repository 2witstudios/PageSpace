import type { Node as PmNode } from 'prosemirror-model';
import type * as Y from 'yjs';
import { yDocToPmDoc } from './collab-document.js';
import { nonEmptyStringAttr } from './pm-attrs.js';
import { pmDocToMarkdown } from './y-doc-to-markdown.js';
import { pmDocToText } from './y-doc-to-text.js';

/**
 * One addressable unit of a document.
 *
 * This projection is the replacement for line-number addressing. Today AI and
 * MCP tools read `pages.content`, splice it by line number and write the whole
 * string back — and line numbers over HTML are meaningless, which is exactly
 * why `addLineBreaksForAI` exists to fabricate them by regex-injecting
 * newlines into markup. Against a lagging projection a line splice does not
 * produce a merge conflict; it lands in the wrong place and corrupts live
 * text.
 *
 * A `blockId` is stable across edits elsewhere in the document (that is what
 * the schema's `blockId` attribute is for), so `replace_block(blockId, …)`
 * addresses the same block a human is looking at even after concurrent edits
 * above it.
 */
export interface DocumentBlock {
  /**
   * The block's stable identity, or `null` for a block written before
   * `blockId` stamping existed. A `null` id is not an error — most stored
   * content predates v1 — but it IS unaddressable, so a caller that means to
   * write must stamp ids first rather than fall back to the index.
   */
  blockId: string | null;
  /** The schema node name: `paragraph`, `heading`, `table`, … */
  type: string;
  /**
   * Position among the document's top-level blocks. Present for rendering and
   * ordering only; it is invalidated by any concurrent insert above this
   * block, which is the whole reason `blockId` exists.
   */
  index: number;
  /** The block's prose, no markup — same rules as the text projection. */
  text: string;
  /** The block rendered on its own, same rules as the markdown projection. */
  markdown: string;
}

/**
 * The document as its top-level blocks. Nesting is deliberately not flattened:
 * a list is one block, because "replace this list" is an operation a caller
 * can express safely and "replace the third `listItem` of the second list" is
 * not — the latter is a position, and positions do not survive concurrency.
 */
export function yDocToBlocks(yDoc: Y.Doc): DocumentBlock[] {
  return pmDocToBlocks(yDocToPmDoc(yDoc));
}

/** `yDocToBlocks` over an already-materialised ProseMirror document. */
export function pmDocToBlocks(doc: PmNode): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  doc.forEach((node, _offset, index) => {
    blocks.push({
      blockId: nonEmptyStringAttr(node.attrs, 'blockId'),
      type: node.type.name,
      index,
      text: pmDocToText(node),
      // Wrapped in a fresh `doc` rather than serialized directly.
      // `MarkdownSerializer.serialize` renders its argument's CHILDREN, so
      // handing it a `heading` would emit the heading's inline text with no
      // `#` and a `bulletList` with no bullets — the block's own markup is
      // produced by the node serializer that the parent's render invokes.
      // `topNodeType`, not the literal `'doc'`: the root's name is a schema
      // property, and the markdown guard already resolves it that way.
      markdown: pmDocToMarkdown(node.type.schema.topNodeType.create(null, node)).trimEnd(),
    });
  });
  return blocks;
}
