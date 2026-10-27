import { describe, it } from 'vitest';
import { assert } from './riteway.js';
import { encodeControlInstruction } from '../encode-control-instruction.js';
import type { ControlClaims } from '../control-instruction.js';

const claims: ControlClaims = {
  v: 1,
  aud: 'pagespace-browser-worker',
  sid: 'bws_a',
  iat: 1,
  exp: 2,
  nonce: 'nonce_0123456789abcdef',
  actor: { kind: 'agent', agentId: 'agent-1' },
  command: { type: 'operation', operation: { kind: 'screenshot' } },
};

describe('encodeControlInstruction', () => {
  it('signs exactly the payload segment it emits', () => {
    const signed: Uint8Array[] = [];
    const encoded = encodeControlInstruction({
      claims,
      sign: (message) => {
        signed.push(message);
        return new Uint8Array([1, 2, 3]);
      },
    });
    const [payload, signature] = encoded.split('.');
    assert({
      given: 'claims and a signer',
      should: 'emit base64url(JSON claims) and base64url(signature over that payload segment)',
      actual: {
        parts: encoded.split('.').length,
        claims: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
        signature,
        signedPayload: new TextDecoder().decode(signed[0]),
      },
      expected: { parts: 2, claims, signature: Buffer.from([1, 2, 3]).toString('base64url'), signedPayload: payload },
    });
  });
});
