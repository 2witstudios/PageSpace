/** RED stub — real `node:http` loopback server lands in GREEN. */
import type { LoopbackServer } from './loopback-flow.js';

export const LOOPBACK_HOST = '127.0.0.1';

export class PortBindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PortBindError';
  }
}

export function createLoopbackServer(): Promise<LoopbackServer> {
  throw new Error('not implemented');
}
