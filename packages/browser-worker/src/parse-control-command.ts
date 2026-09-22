import type { ControlCommand } from './control-instruction.js';

export const parseControlCommand = (_value: unknown): ControlCommand | null => {
  throw new Error('parseControlCommand: not implemented (RED)');
};
