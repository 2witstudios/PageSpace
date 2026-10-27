/**
 * Do the projectors actually cover the frozen schema?
 *
 * Every other guard in this package is per-DOCUMENT and at RUNTIME: an
 * unhandled node throws `UnknownNodeError` when a document containing one is
 * projected. That is fail-closed, but it fails in the collab service rather
 * than in the pull request. Add a node in a Class B schema change and forget
 * one projector, and CI stays green — `SCHEMA_HASH` moves, which the drift
 * guard catches, but nothing compares the schema's node set against what each
 * projector can render. The first production document containing the new node
 * then throws on every flush, forever.
 *
 * These tests close that gap by comparing the two enumerable sets directly, so
 * a forgotten projector is red here instead of loud in production.
 */
import { describe, it, expect } from 'vitest';
import type { Node as PmNode } from 'prosemirror-model';
import { collabSchema } from '../collab-document.js';
import { pmDocToText } from '../y-doc-to-text.js';
import { pmDocToMarkdown } from '../y-doc-to-markdown.js';
import { pmDocToHtml } from '../y-doc-to-html.js';
import { BLOCK_NODE_TYPES } from '../block-id.js';

const schema = collabSchema();
const schemaNodeNames = Object.keys(schema.nodes).sort();

/**
 * One minimal, valid document containing `nodeName`, built through
 * `createAndFill` so ProseMirror synthesises whatever required content the
 * node's own content expression demands. Returns `null` for nodes that cannot
 * be placed at the top level (`text`, `listItem`, `tableRow`, …) — those are
 * reached through their parents, which the corpus already covers.
 */
function documentContaining(nodeName: string): PmNode | null {
  const type = schema.nodes[nodeName];
  if (type === schema.topNodeType) {
    return schema.topNodeType.createAndFill();
  }
  const node = type.createAndFill();
  if (node === null || !schema.topNodeType.contentMatch.matchType(type)) {
    return null;
  }
  return schema.topNodeType.createAndFill(null, [node]);
}

describe('every schema node is projectable', () => {
  const placeable = schemaNodeNames.filter((name) => documentContaining(name) !== null);

  it('covers enough of the schema for this suite to be meaningful', () => {
    // Guards the guard: if `documentContaining` silently stopped being able to
    // build anything, every case below would vacuously pass.
    expect(placeable.length).toBeGreaterThanOrEqual(10);
    expect(placeable).toContain('table');
    expect(placeable).toContain('taskList');
    expect(placeable).toContain('image');
  });

  it.each(placeable)('projects a document containing %s to all four formats', (nodeName) => {
    const doc = documentContaining(nodeName);
    expect(doc).not.toBeNull();
    if (doc === null) {
      return;
    }
    // Not asserting the OUTPUT — the corpus suites do that. Asserting only that
    // no projector refuses a node the frozen schema describes.
    expect(() => pmDocToText(doc)).not.toThrow();
    expect(() => pmDocToMarkdown(doc)).not.toThrow();
    expect(() => pmDocToHtml(doc)).not.toThrow();
  });

  it('the markdown serializer knows every schema node except the root', () => {
    // The direct set comparison, which catches nodes `documentContaining`
    // cannot place at the top level (`listItem`, `tableCell`, `hardBreak`, …).
    // `doc` is legitimately absent: `MarkdownSerializer.serialize` renders the
    // root's CHILDREN, so the root never reaches a node serializer.
    const missing = schemaNodeNames.filter(
      (name) => name !== schema.topNodeType.name && !markdownHandles(name),
    );
    expect(missing).toEqual([]);
  });
});

function markdownHandles(nodeName: string): boolean {
  // Probed through the public projector rather than by reaching into the
  // serializer's node map: what matters is that projecting does not throw
  // `UnknownNodeError`, which is the contract callers actually depend on.
  const type = schema.nodes[nodeName];
  const node = type.createAndFill();
  if (node === null) {
    return true;
  }
  try {
    pmDocToMarkdown(schema.topNodeType.create(null, wrapForRoot(node)));
    return true;
  } catch (error) {
    return !(error instanceof Error && error.name === 'UnknownNodeError');
  }
}

/**
 * Places `node` under the root, wrapping it in whatever parents its content
 * expression requires (a `listItem` needs a list, a `tableCell` needs a row and
 * a table), so a non-top-level node still reaches the projectors.
 */
function wrapForRoot(node: PmNode): PmNode {
  if (schema.topNodeType.contentMatch.matchType(node.type)) {
    return node;
  }
  for (const parentName of Object.keys(schema.nodes)) {
    const parent = schema.nodes[parentName];
    if (parent === schema.topNodeType || !parent.contentMatch.matchType(node.type)) {
      continue;
    }
    const wrapped = parent.createAndFill(null, [node]);
    if (wrapped !== null) {
      const placed = wrapForRoot(wrapped);
      if (schema.topNodeType.contentMatch.matchType(placed.type)) {
        return placed;
      }
    }
  }
  return schema.nodes.paragraph.create();
}

describe('blockId covers every block node', () => {
  /**
   * `BLOCK_NODE_TYPES` (`block-id.ts`) is the hand-written list of node types
   * that get a `blockId` stamped on them, and it is the one place in this
   * package that fails OPEN. Add a block node to the frozen schema, forget it
   * here, and nothing throws: `pmDocToBlocks` reports `blockId: null` for it
   * forever, which its own docstring defines as *unaddressable*. The `null`
   * branch is a legitimate value for pre-v1 content, so every caller takes its
   * nothing-to-do path and reports success — the block tools simply cannot
   * target that block type, silently.
   *
   * The list cannot be derived from the finished schema (it is an INPUT to
   * building it), but it can be closed over it.
   */
  it('lists exactly the schema nodes in the block group, plus the two list items', () => {
    const blockGroupNodes = Object.keys(schema.nodes).filter((name) =>
      (schema.nodes[name].spec.group ?? '').split(' ').includes('block'),
    );
    // `listItem`/`taskItem` are not in the `block` group — they are children of
    // a list — but they are the unit a tracked change or comment attaches to,
    // so they carry the attributes too.
    const expected = [...blockGroupNodes, 'listItem', 'taskItem'].sort();
    expect([...BLOCK_NODE_TYPES].sort()).toEqual(expected);
  });
});
