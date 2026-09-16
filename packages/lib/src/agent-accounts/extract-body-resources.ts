/**
 * `extractBodyResources` — the typed body resource slots of a matched
 * registry entry, read from the canonical body bytes (ADR 0004 §3.2; G1c R5).
 *
 * A path-only template cannot see what `chat.postMessage` posts to or whom a
 * mail send reaches, so a restriction on the channel or the recipients was
 * unexpressible. A body slot names a JSON field; its value becomes a resource
 * the restriction and the approval policy are checked against, and because the
 * body is digested (`bodySha256`) the approved request is the one sent.
 *
 * Strict by design: the body must be UTF-8 JSON with an object at the root;
 * every pointer key must be an OWN key of an object; a `string` slot must be a
 * string and a `string_array` slot an array of strings. Anything else is
 * `malformed` — a declared resource the request does not carry is never read
 * as "no resource", which a restriction would otherwise treat as nothing to
 * check. With no slots the body is never parsed.
 *
 * Pure.
 */
import type { ExtractBodyResources } from './canonical-request';

const refuse = { ok: false, reason: 'malformed' } as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseObject(body: Uint8Array): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export const extractBodyResources: ExtractBodyResources = ({ slots, body }) => {
  if (slots.length === 0) return { ok: true, resources: [] };
  const root = parseObject(body);
  if (root === null) return refuse;

  const resources: (readonly [string, string])[] = [];
  for (const { slot, pointer, shape } of slots) {
    let value: unknown = root;
    for (const key of pointer) {
      if (!isObject(value) || !Object.hasOwn(value, key)) return refuse;
      value = value[key];
    }
    if (shape === 'string') {
      if (typeof value !== 'string') return refuse;
      resources.push([slot, value]);
    } else {
      if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) return refuse;
      for (const item of value) resources.push([slot, item]);
    }
  }
  return { ok: true, resources };
};
