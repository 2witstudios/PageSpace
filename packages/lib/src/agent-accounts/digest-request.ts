/**
 * `digestRequest` — `hash(canonicalJson(canonical))` (ADR 0004 §3.2).
 *
 * The projection is REBUILT from the typed canonical request, field by
 * field, before it is serialized: the bytes hashed never depend on the key
 * order of whatever object the caller held, and nothing beside the frozen
 * field set can ride along into the digest. The hash primitive is injected
 * so this module stays free of `node:crypto` (env-bridge discipline).
 *
 * Two requests that differ only by header order, key order, host case or an
 * omitted `:443` were already folded together by `canonicalizeRequest`; two
 * that differ in one body byte differ in `bodySha256` and therefore here.
 * The `operation` is part of the hashed projection so one digest can never
 * serve two operations (the `op` discriminator, `mcp-token-scopes` precedent).
 */
import type { DigestRequest } from './canonical-request';
import type { RequestDigest } from './grant';
import { canonicalJson } from './canonical-json';

export const digestRequest: DigestRequest = ({ canonical, hash }) => {
  const projection = {
    channel: canonical.channel,
    method: canonical.method,
    origin: canonical.origin,
    path: canonical.path,
    query: canonical.query.map(([name, value]) => [name, value] as const),
    headers: canonical.headers.map(([name, value]) => [name, value] as const),
    bodySha256: canonical.bodySha256,
    resources: canonical.resources.map(([key, value]) => [key, value] as const),
    operation: { class: canonical.operation.class, name: canonical.operation.name },
  };
  return hash(new TextEncoder().encode(canonicalJson(projection))) as RequestDigest;
};
