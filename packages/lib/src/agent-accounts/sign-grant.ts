/**
 * `signGrant` — the one place a grant is signed (ADR 0004 §2.2).
 *
 * It exists so no caller ever invents its own byte layout: the signature is
 * always over `encodeGrant(grant)`, the canonical projection rebuilt from the
 * typed value, which is exactly what `verifyGrant` recomputes. A signer that
 * hashed the caller's own object instead would produce signatures that verify
 * only by luck of key order.
 *
 * Pure: the key's `sign` primitive does the crypto; this module touches no
 * environment and no `node:crypto`.
 */
import { encodeGrant } from './encode-grant';
import type { AgentAccountGrant } from './grant';
import type { AuthorityKey } from './account-authority-key';

export type SignGrant = (input: { readonly grant: AgentAccountGrant; readonly key: AuthorityKey }) => string;

export const signGrant: SignGrant = ({ grant, key }) => Buffer.from(key.sign(encodeGrant(grant))).toString('base64');
