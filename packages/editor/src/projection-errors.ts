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
