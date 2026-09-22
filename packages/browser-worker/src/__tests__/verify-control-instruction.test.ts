import { describe, it } from 'vitest';
import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify, type KeyObject } from 'node:crypto';
import { assert } from './riteway.js';
import { verifyControlInstruction } from '../verify-control-instruction.js';
import { encodeControlInstruction } from '../encode-control-instruction.js';
import { CONTROL_INSTRUCTION_MAX_TTL_MS, type ControlClaims } from '../control-instruction.js';

const NOW = 1_700_000_000_000;
const SESSION = 'bws_session_a';

const keyPair = (): { sign: (m: Uint8Array) => Uint8Array; verify: (m: Uint8Array, s: Uint8Array) => boolean; publicKey: KeyObject } => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey,
    sign: (m) => new Uint8Array(nodeSign(null, m, privateKey)),
    verify: (m, s) => nodeVerify(null, m, publicKey, s),
  };
};

const server = keyPair();
const stranger = keyPair();

const claims = (overrides: Partial<ControlClaims> = {}): ControlClaims => ({
  v: 1,
  aud: 'pagespace-browser-worker',
  sid: SESSION,
  iat: NOW - 1_000,
  exp: NOW + 30_000,
  nonce: 'nonce_0123456789abcdef',
  actor: { kind: 'agent', agentId: 'agent-page-1' },
  command: { type: 'operation', operation: { kind: 'read' } },
  ...overrides,
});

const verifyWith = (instruction: string, seenNonces: ReadonlySet<string> = new Set()) =>
  verifyControlInstruction({ instruction, verify: server.verify, now: NOW, sessionId: SESSION, seenNonces });

describe('verifyControlInstruction', () => {
  it('accepts an instruction the server signed for this session', () => {
    const signed = claims();
    assert({
      given: 'a fresh agent operation signed by the pinned server key for this session',
      should: 'accept it and return its claims',
      actual: verifyWith(encodeControlInstruction({ claims: signed, sign: server.sign })),
      expected: { ok: true, claims: signed },
    });
  });

  it('refuses an instruction signed by any other key', () => {
    assert({
      given: 'valid claims signed by a key the worker was not provisioned with',
      should: 'refuse on the signature',
      actual: verifyWith(encodeControlInstruction({ claims: claims(), sign: stranger.sign })),
      expected: { ok: false, reason: 'bad-signature' },
    });
  });

  it('refuses claims altered after signing', () => {
    const genuine = encodeControlInstruction({ claims: claims(), sign: server.sign });
    const forged = encodeControlInstruction({ claims: claims({ sid: 'bws_other' }), sign: stranger.sign });
    const spliced = `${forged.split('.')[0]}.${genuine.split('.')[1]}`;
    assert({
      given: 'a payload for another session carrying a genuine signature from a different payload',
      should: 'refuse on the signature before reading the claims',
      actual: verifyWith(spliced),
      expected: { ok: false, reason: 'bad-signature' },
    });
  });

  it('refuses an instruction for another session', () => {
    assert({
      given: 'a genuine instruction whose session id names another session',
      should: 'refuse as the wrong session',
      actual: verifyWith(encodeControlInstruction({ claims: claims({ sid: 'bws_session_b' }), sign: server.sign })),
      expected: { ok: false, reason: 'wrong-session' },
    });
  });

  it('refuses a replayed nonce', () => {
    assert({
      given: 'a genuine instruction whose nonce the worker has already seen',
      should: 'refuse as replayed',
      actual: verifyWith(encodeControlInstruction({ claims: claims(), sign: server.sign }), new Set(['nonce_0123456789abcdef'])),
      expected: { ok: false, reason: 'replayed' },
    });
  });

  it('enforces the validity window', () => {
    const cases = [
      claims({ iat: NOW - 60_000, exp: NOW - 1 }),
      claims({ iat: NOW - 60_000, exp: NOW }),
      claims({ iat: NOW + 31_000, exp: NOW + 60_000 }),
      claims({ iat: NOW - 1_000, exp: NOW - 1_000 + CONTROL_INSTRUCTION_MAX_TTL_MS + 1 }),
      claims({ iat: NOW, exp: NOW - 5 }),
    ];
    assert({
      given: 'an expired, an exactly-expiring, a future-dated, an over-long and an inverted window',
      should: 'refuse each for its window defect',
      actual: cases.map((c) => verifyWith(encodeControlInstruction({ claims: c, sign: server.sign }))),
      expected: [
        { ok: false, reason: 'expired' },
        { ok: false, reason: 'expired' },
        { ok: false, reason: 'not-yet-valid' },
        { ok: false, reason: 'ttl-too-long' },
        { ok: false, reason: 'expired' },
      ],
    });
  });

  it('refuses the wrong version or audience', () => {
    const wrong = [
      { ...claims(), v: 2 },
      { ...claims(), aud: 'pagespace-env-bridge' },
    ] as unknown as ControlClaims[];
    assert({
      given: 'a genuine signature over a v2 instruction and over another audience',
      should: 'refuse each',
      actual: wrong.map((c) => verifyWith(encodeControlInstruction({ claims: c, sign: server.sign }))),
      expected: [
        { ok: false, reason: 'wrong-version' },
        { ok: false, reason: 'wrong-audience' },
      ],
    });
  });

  it('keeps each actor to its own commands', () => {
    const cases = [
      claims({ command: { type: 'take-over' } }),
      claims({ command: { type: 'human-input', input: { kind: 'text', text: 'x' } } }),
      claims({ command: { type: 'audit' } }),
      claims({ actor: { kind: 'human', userId: 'user-1' }, command: { type: 'operation', operation: { kind: 'read' } } }),
    ];
    assert({
      given: 'an agent asking to take over, type as a human or read the audit, and a human issuing an agent operation',
      should: 'refuse each as a command the actor may not issue',
      actual: cases.map((c) => verifyWith(encodeControlInstruction({ claims: c, sign: server.sign }))),
      expected: cases.map(() => ({ ok: false, reason: 'actor-not-permitted' })),
    });
  });

  it('accepts the human commands from a human', () => {
    const human = { kind: 'human', userId: 'user-1' } as const;
    const commands = [{ type: 'take-over' }, { type: 'release' }, { type: 'view-frame' }, { type: 'audit' }, { type: 'human-input', input: { kind: 'key', key: 'Tab' } }] as const;
    assert({
      given: 'take-over, release, view-frame, audit and human input from a human',
      should: 'accept each',
      actual: commands.map((command) => verifyWith(encodeControlInstruction({ claims: claims({ actor: human, command }), sign: server.sign })).ok),
      expected: commands.map(() => true),
    });
  });

  it('refuses claims that are not well formed', () => {
    const bad = [
      { ...claims(), command: { type: 'operation', operation: { kind: 'evaluate', expression: '1' } } },
      { ...claims(), actor: { kind: 'root' } },
      { ...claims(), actor: { kind: 'agent', agentId: '' } },
      { ...claims(), nonce: 'short' },
      { ...claims(), nonce: 'has spaces in the nonce value' },
      { ...claims(), sid: '' },
      { ...claims(), iat: 'yesterday' },
      { ...claims(), exp: 1.5 },
    ] as unknown as ControlClaims[];
    assert({
      given: 'an untyped command, an unknown actor, an empty agent id, a short or unsafe nonce, an empty session, and non-integer times',
      should: 'refuse each as malformed or as an invalid command',
      actual: bad.map((c) => verifyWith(encodeControlInstruction({ claims: c, sign: server.sign }))),
      expected: [
        { ok: false, reason: 'invalid-command' },
        { ok: false, reason: 'malformed' },
        { ok: false, reason: 'malformed' },
        { ok: false, reason: 'malformed' },
        { ok: false, reason: 'malformed' },
        { ok: false, reason: 'malformed' },
        { ok: false, reason: 'malformed' },
        { ok: false, reason: 'malformed' },
      ],
    });
  });

  it('refuses encodings that are not an instruction', () => {
    const payloadOfNonJson = Buffer.from('not json').toString('base64url');
    const nonJson = `${payloadOfNonJson}.${Buffer.from(server.sign(new TextEncoder().encode(payloadOfNonJson))).toString('base64url')}`;
    const payloadOfArray = Buffer.from('[1,2]').toString('base64url');
    const arrayPayload = `${payloadOfArray}.${Buffer.from(server.sign(new TextEncoder().encode(payloadOfArray))).toString('base64url')}`;
    const inputs = ['', 'abc', 'a.b.c', '.', 'e30.', '!!!.###', nonJson, arrayPayload];
    assert({
      given: 'empty, single-part, three-part, empty-part and non-base64url strings, and signed non-object payloads',
      should: 'refuse each as malformed',
      actual: inputs.map((i) => verifyWith(i)),
      expected: inputs.map(() => ({ ok: false, reason: 'malformed' })),
    });
  });
});
