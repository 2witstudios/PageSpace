import type { ControlClaims, Ed25519Verify } from './control-instruction.js';

export type ControlInstructionDenyReason =
  | 'malformed'
  | 'bad-signature'
  | 'wrong-version'
  | 'wrong-audience'
  | 'wrong-session'
  | 'expired'
  | 'not-yet-valid'
  | 'ttl-too-long'
  | 'replayed'
  | 'invalid-command'
  | 'actor-not-permitted';

export type ControlInstructionVerdict =
  | { readonly ok: true; readonly claims: ControlClaims }
  | { readonly ok: false; readonly reason: ControlInstructionDenyReason };

export type VerifyControlInstructionOptions = {
  readonly instruction: string;
  readonly verify: Ed25519Verify;
  readonly now: number;
  readonly sessionId: string;
  readonly seenNonces: ReadonlySet<string>;
};

export const verifyControlInstruction = (_options: VerifyControlInstructionOptions): ControlInstructionVerdict => {
  throw new Error('verifyControlInstruction: not implemented (RED)');
};
