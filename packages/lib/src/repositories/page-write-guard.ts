/**
 * Backstop for the repository seams that issue a bare `db.update(pages).set(...)`.
 *
 * Those writes bump no revision, record no `page_versions` row, log no activity
 * and broadcast nothing. That is fine for the narrow metadata each seam owns —
 * a title, a trash flag, an agent's model — and never fine for `content`, which
 * has a real write path (`applyPageMutation`) that does the compare-and-swap.
 * Once a Y.Doc is the source of truth for DOCUMENT pages, a bare content write
 * silently discards whatever it holds.
 *
 * Each seam widens its input to `Record<string, unknown>` before spreading it
 * into `set(...)`, so the field can arrive from an `as` cast or an untyped
 * payload with the type system none the wiser. This is the check for that case;
 * the input types are the check for everything else.
 */
export function assertNoContentWrite(data: object, seam: string): void {
  if ('content' in data) {
    throw new Error(
      `${seam} cannot set page content — use applyPageMutation, which does the revision compare-and-swap`
    );
  }
}
