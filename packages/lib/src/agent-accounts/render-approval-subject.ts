/**
 * `renderApprovalSubject` — what the approval UI shows, derived from the
 * canonical request ALONE (ADR 0004 §3.3; threat model B-9/B-22, ASI06).
 *
 * The human approves ONE representation and the executor sends exactly that
 * one. Every field here is a projection of the canonical request; there is
 * no slot for model text, a page body or a compaction summary, so nothing an
 * agent writes can change what the human reads. Method, origin, path, query
 * and operation are in the headline; resources and the body digest are their
 * own fields. `bodyBytes` comes from the
 * projected `content-length`, which `canonicalizeRequest` derives from the
 * body bytes themselves (a caller's own claim is refused when it disagrees).
 *
 * Pure: no I/O.
 */
import type { RenderApprovalSubject } from './canonical-request';

export const renderApprovalSubject: RenderApprovalSubject = ({ canonical }) => {
  const contentLength = canonical.headers.find(([name]) => name === 'content-length');
  const bodyBytes = contentLength === undefined ? 0 : Number.parseInt(contentLength[1], 10);
  // The query is part of what is digested, so it is part of what the human
  // reads: `/transfer?to=alice` and `/transfer?to=bob` must not look alike.
  // It is rendered in its canonical form (sorted, still percent-encoded), which
  // cannot carry a control character, a space or a non-ASCII separator.
  const query = canonical.query.map(([name, value]) => `${name}=${value}`).join('&');
  const target = `${canonical.origin}${canonical.path}${query.length > 0 ? `?${query}` : ''}`;
  return {
    headline: `${canonical.method} ${target} — ${canonical.operation.name} (${canonical.operation.class})`,
    origin: canonical.origin,
    operation: { class: canonical.operation.class, name: canonical.operation.name },
    resources: canonical.resources.map(([key, value]) => [key, value] as const),
    bodySha256: canonical.bodySha256,
    bodyBytes: Number.isFinite(bodyBytes) ? bodyBytes : 0,
  };
};
