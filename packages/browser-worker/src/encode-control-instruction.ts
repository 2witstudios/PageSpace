import type { ControlClaims, Ed25519Sign, EncodedControlInstruction } from './control-instruction.js';

export type EncodeControlInstructionOptions = {
  readonly claims: ControlClaims;
  readonly sign: Ed25519Sign;
};

export const encodeControlInstruction = (_options: EncodeControlInstructionOptions): EncodedControlInstruction => {
  throw new Error('encodeControlInstruction: not implemented (RED)');
};
