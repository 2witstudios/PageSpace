/**
 * `deriveGitResources` — the resources of a relay operation that are not in
 * its URL, parsed from the git smart-HTTP request itself (ADR 0004 §3.2,
 * ADR 0006 §7; G1c R11).
 *
 * A push names its refs in the `git-receive-pack` request body, not the path,
 * so a branch restriction had nothing to bind and the relay had to build
 * resources on its own. The command list is the start of the body: pkt-lines
 * (four hex digits of total length, then the payload) of the form
 * `<old-oid> <new-oid> <ref-name>`, the first one followed by NUL and the
 * capability list, ended by a flush packet `0000`. The pack data after the
 * flush is not read here — it is covered by `bodySha256`, and so are these
 * refs, which is what recomputes the digest over exactly what is pushed.
 *
 * A ref name that starts with `-`, a branch name that starts with `-`, or a
 * ref carrying NUL or another control character is `flag_injection`
 * (ADR 0006 F6), checked before anything is bound. Everything else that does
 * not parse is `malformed`: no silent partial reads.
 *
 * Pure.
 */
import type { DeriveGitResources } from './canonical-request';

const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HEX4_RE = /^[0-9a-f]{4}$/;
const BRANCH_PREFIX = 'refs/heads/';
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

type Parsed = { readonly ok: true; readonly refs: readonly string[] } | { readonly ok: false; readonly reason: 'malformed' | 'flag_injection' };

function parseCommandList(body: Uint8Array): Parsed {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const refs: string[] = [];
  let offset = 0;
  for (;;) {
    if (offset + 4 > body.byteLength) return { ok: false, reason: 'malformed' };
    let header: string;
    try {
      header = decoder.decode(body.subarray(offset, offset + 4));
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    if (!HEX4_RE.test(header)) return { ok: false, reason: 'malformed' };
    const length = Number.parseInt(header, 16);
    if (length === 0) break;
    if (length < 4 || offset + length > body.byteLength) return { ok: false, reason: 'malformed' };

    let payload: string;
    try {
      payload = decoder.decode(body.subarray(offset + 4, offset + length));
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    offset += length;

    if (payload.endsWith('\n')) payload = payload.slice(0, -1);
    if (refs.length === 0) {
      const nul = payload.indexOf('\u0000');
      if (nul === -1) return { ok: false, reason: 'malformed' };
      payload = payload.slice(0, nul);
    }
    const parts = payload.split(' ');
    if (parts.length !== 3) return { ok: false, reason: 'malformed' };
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (ref.startsWith('-') || CONTROL_RE.test(ref)) return { ok: false, reason: 'flag_injection' };
    if (!OID_RE.test(oldOid) || !OID_RE.test(newOid) || oldOid.length !== newOid.length || ref.length === 0) return { ok: false, reason: 'malformed' };
    if (ref.startsWith(BRANCH_PREFIX) && ref.slice(BRANCH_PREFIX.length).startsWith('-')) return { ok: false, reason: 'flag_injection' };
    refs.push(ref);
  }
  return refs.length === 0 ? { ok: false, reason: 'malformed' } : { ok: true, refs };
}

export const deriveGitResources: DeriveGitResources = ({ method, rules, body }) => {
  if (rules.length === 0) return { ok: true, resources: [] };
  if (method !== 'git-receive-pack') return { ok: false, reason: 'malformed' };
  const parsed = parseCommandList(body);
  if (!parsed.ok) return parsed;

  const resources: (readonly [string, string])[] = [];
  for (const { slot, source } of rules) {
    for (const ref of parsed.refs) {
      if (source === 'receive_pack_ref_names') resources.push([slot, ref]);
      // Every ref gets a branch value: a branch its short name, anything else (a tag, HEAD, refs/meta/*)
      // its full name, which no branch allowlist of short names contains — a push can never update a
      // ref the restriction did not see (G1c review of #2660).
      else resources.push([slot, ref.startsWith(BRANCH_PREFIX) ? ref.slice(BRANCH_PREFIX.length) : ref]);
    }
  }
  return { ok: true, resources };
};
