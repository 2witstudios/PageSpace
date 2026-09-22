import { generateKeyPairSync, randomBytes, sign as nodeSign } from 'node:crypto';
import { encodeControlInstruction } from '../../encode-control-instruction.js';
import type { ControlActor, ControlCommand } from '../../control-instruction.js';

export type TestSigner = {
  readonly publicKey: string;
  readonly instruct: (options: { readonly sid: string; readonly actor: ControlActor; readonly command: ControlCommand; readonly now?: number }) => string;
};

/** A real Ed25519 key pair standing in for the web server's control key. */
export const createTestSigner = (): TestSigner => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    instruct: ({ sid, actor, command, now = Date.now() }) =>
      encodeControlInstruction({
        claims: { v: 1, aud: 'pagespace-browser-worker', sid, iat: now, exp: now + 30_000, nonce: randomBytes(18).toString('base64url'), actor, command },
        sign: (message) => new Uint8Array(nodeSign(null, message, privateKey)),
      }),
  };
};
