import type { Node as PmNode } from 'prosemirror-model';

/**
 * Thrown when a projector meets a node or mark the frozen schema does not
 * describe.
 *
 * **This package fails closed, and that is a deliberate cost.** The tempting
 * alternative — skip what you don't recognise and project the rest — makes a
 * projector *degrade silently*: search goes permanently stale for the affected
 * documents, AI context quietly loses a table, export drops a construct, and
 * nothing anywhere reports a problem. A projection is written on every flush,
 * forever; a lossy one written once is a corrupt row that no later fix can
 * distinguish from a document that legitimately lacked that content.
 *
 * A throw, by contrast, is loud, attributable to a document, and recoverable:
 * `pages.content` still holds the previous projection.
 */
export class UnknownNodeError extends Error {
  readonly nodeName: string;
  readonly projection: string;

  constructor(nodeName: string, projection: string) {
    super(
      `Cannot project node "${nodeName}" to ${projection}: not part of the frozen ` +
        'COLLAB_SCHEMA_VERSION v1 schema. Refusing to write a lossy projection.',
    );
    this.name = 'UnknownNodeError';
    this.nodeName = nodeName;
    this.projection = projection;
  }
}

/**
 * Thrown by `htmlToPmDoc` when parsing stored HTML against the frozen schema
 * would lose content — text that vanished, or a content-bearing element the
 * schema has no node for (an `<img>` with no `data-file-id`, an `<iframe>`,
 * raw-HTML passthrough).
 *
 * Same reasoning as `UnknownNodeError`, on the inbound half: seeding a `Y.Doc`
 * from a lossy parse makes the loss permanent the moment the first
 * collaborator connects, because the Y.Doc then *is* the document. Callers
 * that need to survey before seeding should use `describeHtmlLoss` rather
 * than catching this.
 */
export class UnrepresentableContentError extends Error {
  /** Human-readable, content-free reasons — never the offending markup. */
  readonly reasons: string[];

  constructor(reasons: string[]) {
    super(
      `Parsing this HTML against the frozen schema would lose content: ${reasons.join('; ')}. ` +
        'Refusing to seed a lossy document.',
    );
    this.name = 'UnrepresentableContentError';
    this.reasons = reasons;
  }
}

/**
 * The fail-closed walk itself, shared by every projector that renders through
 * a node/mark map rather than through an exhaustive `switch`.
 *
 * The mechanism is shared; the SETS deliberately are not. Each projection
 * decides for itself what it can represent — the markdown serializer's node map
 * legitimately differs from the schema (it has no `doc` entry, because
 * `MarkdownSerializer.serialize` renders the root's children rather than the
 * root) — and forcing one set on both would either add meaningless entries or
 * turn a design decision into the wrong compile error. What must NOT differ is
 * the walk: before this was one function, the HTML guard checked the root node
 * and the markdown guard did not, silently applying two different rules to the
 * same document. A future third guard also cannot now forget the marks half.
 *
 * Callers pass PRE-BUILT sets. Building them here would allocate two `Set`s per
 * call, and `pmDocToBlocks` calls a projection once per block — measured at 400
 * throwaway sets and ~40% of its total runtime for a 200-block document.
 */
export function assertProjectable(
  doc: PmNode,
  projection: string,
  knownNodes: ReadonlySet<string>,
  knownMarks: ReadonlySet<string>,
): void {
  const check = (node: PmNode): void => {
    if (!knownNodes.has(node.type.name)) {
      throw new UnknownNodeError(node.type.name, projection);
    }
    for (const mark of node.marks) {
      if (!knownMarks.has(mark.type.name)) {
        throw new UnknownNodeError(mark.type.name, projection);
      }
    }
  };
  // `descendants` does not visit the root, and the root is a node like any
  // other — a document whose top node the projection cannot represent is not
  // projectable.
  check(doc);
  doc.descendants((node) => {
    check(node);
    return true;
  });
}
