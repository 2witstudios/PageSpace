/**
 * Machine signatures — what this daemon signs with the key that never left
 * the credential store (invariants 2 and 7):
 *
 * - `signResultFrame`: every `exec_result` / `fs_read_result` /
 *   `fs_write_result` / `grant_denied` is signed over `{grantId, resultHash}`,
 *   where `resultHash` covers every payload field. The bytes come from the
 *   pure core (`resultHashForFrame`, `encodeResultForSigning`) — the same
 *   functions the server's `verifyMachineResult` recomputes — so the two
 *   sides agree by construction. `result-signer.test.ts` proves it by
 *   round-tripping through the real lib verifier.
 * - `signHello`: the first frame on every socket, signed over
 *   `{envId, capabilities, policyDigest}` via `encodeHelloForSigning`.
 */
import {
  encodeHelloForSigning,
  encodeResultForSigning,
  resultHashForFrame,
  type HelloFrame,
  type MachineResultFrame,
  type MachineResultFrameType,
} from './lib-core.js';
import type { HashBytes } from './lib-core.js';
import type { SignWithMachineKey } from './keypair.js';

/** A result frame before its signature is attached — what the runners produce. */
export type UnsignedMachineResultFrame = {
  [K in MachineResultFrameType]: Omit<Extract<MachineResultFrame, { type: K }>, 'sig'>;
}[MachineResultFrameType];

export interface MachineSignerDeps {
  /** Base64 PKCS#8 DER, read from the credential store. */
  readonly privateKey: string;
  readonly sign: SignWithMachineKey;
  readonly hash: HashBytes;
}

export function signResultFrame(unsigned: UnsignedMachineResultFrame, deps: MachineSignerDeps): MachineResultFrame {
  // `sig` is envelope, not payload: the hash is over the typed fields only, so
  // a placeholder changes nothing (mirrors the server signer's provisional frame).
  const provisional = { ...unsigned, sig: '' } as MachineResultFrame;
  const resultHash = resultHashForFrame(provisional, deps.hash);
  const sig = deps.sign(deps.privateKey, encodeResultForSigning({ grantId: unsigned.grantId, resultHash }));
  return { ...unsigned, sig } as MachineResultFrame;
}

export function signHello(unsigned: Omit<HelloFrame, 'sig'>, deps: Pick<MachineSignerDeps, 'privateKey' | 'sign'>): HelloFrame {
  const sig = deps.sign(deps.privateKey, encodeHelloForSigning(unsigned));
  return { ...unsigned, sig };
}
