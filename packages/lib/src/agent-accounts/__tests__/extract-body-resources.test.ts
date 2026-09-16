/**
 * ADR 0004 §3.2, §8.38 — typed body resource slots (G1c R5). Written RED
 * before `extract-body-resources.ts` exists (Control Board §7.2).
 */
import { describe, expect, it } from 'vitest';
import type { BodyResourceSlot } from '../canonical-request';
import { extractBodyResources } from '../extract-body-resources';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const CHANNEL: BodyResourceSlot = { slot: 'channel', pointer: ['channel'], shape: 'string' };
const RECIPIENTS: BodyResourceSlot = { slot: 'to', pointer: ['message', 'to'], shape: 'string_array' };

describe('extractBodyResources (G1c R5)', () => {
  it('given a string slot present in a JSON object body, should bind its value', () => {
    const actual = extractBodyResources({ slots: [CHANNEL], body: utf8('{"channel":"C1","text":"hi"}') });
    expect(actual).toEqual({ ok: true, resources: [['channel', 'C1']] });
  });

  it('given a nested string_array slot, should bind one pair per element in input order, duplicates kept', () => {
    const actual = extractBodyResources({ slots: [RECIPIENTS], body: utf8('{"message":{"to":["b@x","a@x","b@x"]}}') });
    expect(actual).toEqual({
      ok: true,
      resources: [
        ['to', 'b@x'],
        ['to', 'a@x'],
        ['to', 'b@x'],
      ],
    });
  });

  it('given several slots, should bind them in slot declaration order', () => {
    const actual = extractBodyResources({ slots: [RECIPIENTS, CHANNEL], body: utf8('{"channel":"C1","message":{"to":["a@x"]}}') });
    expect(actual).toEqual({
      ok: true,
      resources: [
        ['to', 'a@x'],
        ['channel', 'C1'],
      ],
    });
  });

  it('given no slots, should bind nothing and never parse the body', () => {
    const actual = extractBodyResources({ slots: [], body: utf8('not json at all') });
    expect(actual).toEqual({ ok: true, resources: [] });
  });

  it('given a declared slot the body does not carry, or carries in another shape, should refuse malformed — never an empty resource', () => {
    const bodies = ['{"text":"hi"}', '{"channel":7}', '{"channel":null}', '{"channel":["C1"]}'];
    const actual = bodies.map((body) => extractBodyResources({ slots: [CHANNEL], body: utf8(body) }));
    expect(actual).toEqual(bodies.map(() => ({ ok: false, reason: 'malformed' })));
  });

  it('given a string_array slot whose value is not an array of strings, or whose pointer walks through a non-object, should refuse malformed', () => {
    const bodies = ['{"message":{"to":"a@x"}}', '{"message":{"to":["a@x",3]}}', '{"message":["to"]}', '{"message":"to"}'];
    const actual = bodies.map((body) => extractBodyResources({ slots: [RECIPIENTS], body: utf8(body) }));
    expect(actual).toEqual(bodies.map(() => ({ ok: false, reason: 'malformed' })));
  });

  it('given a body that is not UTF-8 JSON, or is JSON but not an object, should refuse malformed when a slot is declared', () => {
    const bodies = [utf8('channel=C1'), new Uint8Array([0xff, 0xfe, 0x7b]), utf8('["C1"]'), utf8('"C1"'), new Uint8Array(0)];
    const actual = bodies.map((body) => extractBodyResources({ slots: [CHANNEL], body }));
    expect(actual).toEqual(bodies.map(() => ({ ok: false, reason: 'malformed' })));
  });

  it('given a pointer key that names an inherited property, should refuse malformed — only own keys are read', () => {
    const proto: BodyResourceSlot = { slot: 'x', pointer: ['constructor', 'name'], shape: 'string' };
    const actual = extractBodyResources({ slots: [proto], body: utf8('{}') });
    expect(actual).toEqual({ ok: false, reason: 'malformed' });
  });
});
