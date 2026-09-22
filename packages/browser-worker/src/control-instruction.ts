/**
 * The signed instruction the browser worker obeys, and nothing else.
 *
 * WHY SIGNED (S3 §3.2 last row, §3.3 round-4 amendment): the worker listens
 * on one port that the substrate's edge relays to. The edge strips
 * `Authorization`, and page JavaScript in the worker's own Chromium, or any
 * other process on the substrate, can reach that port too. So a request's
 * origin proves nothing. The worker instead accepts a request only when it
 * carries an Ed25519 signature, by the one server key it was provisioned
 * with, over claims that bind:
 *
 *  - the session (`sid`): an instruction for session A is refused by B;
 *  - the actor (`actor`): the agent and a human are different principals
 *    with different permitted commands (`decideActionAdmission`);
 *  - the time (`iat`/`exp`, at most {@link CONTROL_INSTRUCTION_MAX_TTL_MS});
 *  - a single-use `nonce`: a captured instruction cannot be replayed.
 *
 * The private key never leaves the web server; the worker holds only the
 * public half, so a compromised worker cannot mint instructions for another
 * session.
 */
import type { BrowserOperation } from './browser-operation.js';

export const CONTROL_INSTRUCTION_VERSION = 1;
export const CONTROL_INSTRUCTION_AUDIENCE = 'pagespace-browser-worker';
/** An instruction authorizes one request; a minute covers relay latency and a cold wake. */
export const CONTROL_INSTRUCTION_MAX_TTL_MS = 60_000;
/** Tolerated clock difference between the web server and the worker. */
export const CONTROL_INSTRUCTION_MAX_CLOCK_SKEW_MS = 30_000;
/** Header carrying the encoded instruction on every worker request. */
export const CONTROL_INSTRUCTION_HEADER = 'x-ps-browser-instruction';

export type ControlActor =
  | { readonly kind: 'agent'; readonly agentId: string }
  | { readonly kind: 'human'; readonly userId: string };

/** A human's input through the live pane — pixels and keys, never a DOM query. */
export type HumanInput =
  | { readonly kind: 'click'; readonly x: number; readonly y: number }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'key'; readonly key: HumanKey };

export const HUMAN_KEYS = ['Enter', 'Tab', 'Backspace', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] as const;
export type HumanKey = (typeof HUMAN_KEYS)[number];

export type ControlCommand =
  | { readonly type: 'operation'; readonly operation: BrowserOperation }
  | { readonly type: 'take-over' }
  | { readonly type: 'release' }
  | { readonly type: 'view-frame' }
  | { readonly type: 'human-input'; readonly input: HumanInput }
  | { readonly type: 'audit' };

export type ControlCommandType = ControlCommand['type'];

export type ControlClaims = {
  readonly v: typeof CONTROL_INSTRUCTION_VERSION;
  readonly aud: typeof CONTROL_INSTRUCTION_AUDIENCE;
  readonly sid: string;
  readonly iat: number;
  readonly exp: number;
  readonly nonce: string;
  readonly actor: ControlActor;
  readonly command: ControlCommand;
};

/** The wire form: `<base64url(payload JSON)>.<base64url(signature)>`. */
export type EncodedControlInstruction = string;

/** Ed25519 over raw bytes, injected so the decision stays free of `node:crypto`. */
export type Ed25519Sign = (message: Uint8Array) => Uint8Array;
export type Ed25519Verify = (message: Uint8Array, signature: Uint8Array) => boolean;
