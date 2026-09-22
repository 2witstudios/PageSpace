/**
 * Claims → the wire form `<base64url(JSON)>.<base64url(signature)>` — pure,
 * given the signer. The signature covers the payload SEGMENT exactly as
 * emitted (JWS-style), so the verifier checks the bytes it received before
 * it parses a single field, and no canonical-JSON agreement is needed.
 */
import type { ControlClaims, Ed25519Sign, EncodedControlInstruction } from './control-instruction.js';

export type EncodeControlInstructionOptions = {
  readonly claims: ControlClaims;
  readonly sign: Ed25519Sign;
};

export const encodeControlInstruction = ({ claims, sign }: EncodeControlInstructionOptions): EncodedControlInstruction => {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = Buffer.from(sign(new TextEncoder().encode(payload))).toString('base64url');
  return `${payload}.${signature}`;
};
