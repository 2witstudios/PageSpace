/**
 * The machine's identity for the env bridge: an Ed25519 keypair generated
 * HERE, on the user's machine, at enrollment (Local Environments epic,
 * invariant 2). The private half is handed straight to the credential store
 * (keychain, 0600 file fallback) as a `machine`-kind credential and is read
 * back only to sign — it never leaves the machine, is never printed, and
 * never travels to the server. The server pins only the public half.
 *
 * Wire formats match what the server verifies: public key as base64 SPKI
 * DER, private key as base64 PKCS#8 DER, signatures as base64.
 */
import { createPrivateKey, generateKeyPairSync, sign as nodeSign } from 'node:crypto';

export interface MachineKeypair {
  /** Base64 PKCS#8 DER. Store it; never print it. */
  readonly privateKey: string;
  /** Base64 SPKI DER. What the server pins. */
  readonly publicKey: string;
}

export type GenerateMachineKeypair = () => MachineKeypair;
export type SignWithMachineKey = (privateKey: string, message: Uint8Array) => string;

export const generateMachineKeypair: GenerateMachineKeypair = () => {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
};

/** Ed25519 signature (base64) over `message` with the stored private key. */
export const signWithMachineKey: SignWithMachineKey = (privateKey, message) =>
  Buffer.from(nodeSign(null, message, createPrivateKey({ key: Buffer.from(privateKey, 'base64'), type: 'pkcs8', format: 'der' }))).toString('base64');

/**
 * The bytes the machine signs to prove it holds the key — byte-for-byte the
 * server's `encodeChallenge` in `@pagespace/lib/env-bridge/challenge`: a
 * fixed key order, no whitespace. Duplicated here rather than imported so the
 * CLI stays free of the server library; `keypair.test.ts` pins the literal.
 */
export function encodeChallenge(challenge: { nonce: string; enrollmentId: string; exp: number }): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ nonce: challenge.nonce, enrollmentId: challenge.enrollmentId, exp: challenge.exp }));
}
