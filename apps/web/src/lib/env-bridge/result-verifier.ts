/**
 * Result verifier — the server end of invariant 7. Before ANY `exec_result`,
 * `fs_read_result`, `fs_write_result` or `grant_denied` reaches the agent, its
 * machine signature over `{grantId, resultHash}` is verified under the public
 * key the env's enrollment pinned. A result that does not verify is not
 * delivered — the pending request is failed with a typed `unverified_result`
 * (see `bridge-client.ts`), and the event is logged.
 *
 * The bytes and the payload projection live in the pure core
 * (`env-bridge/machine-signatures.ts`), where the daemon (t08) produces them;
 * this module only binds the node primitives and the stored key format.
 *
 * PTY frames (`pty_data`, `pty_exit`) and `pong` are OUTSIDE this verifier by
 * design — see founder decision [D-2] on the epic page ("PTY is a
 * session-bound channel, not per-frame grants"; recommended (b): a per-session
 * HMAC derived at `pty_open`). Whatever is decided slots in beside this
 * verifier for PTY frames; exec/fs verification here does not change.
 */
import { verifyMachineResult, type MachineResultFrame, type MachineSignatureDenyReason } from '@pagespace/lib/env-bridge/machine-signatures';
import { decodePinnedPublicKey, ed25519Verify, envBridgeHash } from './crypto';

export type ResultVerification =
  | { readonly ok: true; readonly resultHash: string }
  | { readonly ok: false; readonly reason: MachineSignatureDenyReason | 'bad_public_key' };

export function verifyResultFromMachine(input: { frame: MachineResultFrame; machinePublicKey: string | null }): ResultVerification {
  const publicKey = decodePinnedPublicKey(input.machinePublicKey);
  if (publicKey === null) return { ok: false, reason: 'bad_public_key' };
  return verifyMachineResult({ frame: input.frame, machinePublicKey: publicKey, verify: ed25519Verify, hash: envBridgeHash });
}
