import { describe, it, expect } from 'vitest';
import { assert } from '../../__tests__/riteway';
import { buildPortsWatchUrl, openPortsWatch, readPortsWatchFrame, type PortsWatchFrame, type PortsWatchSocketLike } from '../ports-watch';

describe('buildPortsWatchUrl', () => {
  it('derives the wss endpoint from the API base and encodes the sprite name', () => {
    assert({
      given: 'the production API base',
      should: 'point at /v1/sprites/{name}/ports/watch over wss',
      actual: buildPortsWatchUrl('https://api.sprites.dev', 'ps-a b'),
      expected: 'wss://api.sprites.dev/v1/sprites/ps-a%20b/ports/watch',
    });
    assert({ given: 'an http base', should: 'use ws', actual: buildPortsWatchUrl('http://localhost:8123/x?y', 'n'), expected: 'ws://localhost:8123/v1/sprites/n/ports/watch' });
  });
});

describe('readPortsWatchFrame', () => {
  it('parses a port_list snapshot, dropping malformed entries', () => {
    assert({
      given: 'a snapshot with one bad entry',
      should: 'keep the good ports',
      actual: readPortsWatchFrame(JSON.stringify({ type: 'port_list', ports: [{ port: 5173, pid: 3, address: '10.0.0.1' }, { port: 'x' }, { port: 8080 }] })),
      expected: { type: 'port_list', ports: [{ port: 5173, pid: 3 }, { port: 8080 }] },
    });
  });

  it('parses port_opened / port_closed from string, buffer and object', () => {
    const opened = { type: 'port_opened', port: 3000, address: '10.0.0.1', pid: 9 };
    assert({ given: 'string', should: 'parse', actual: readPortsWatchFrame(JSON.stringify(opened)), expected: opened });
    assert({ given: 'buffer', should: 'parse', actual: readPortsWatchFrame(Buffer.from(JSON.stringify({ type: 'port_closed', port: 3000 }))), expected: { type: 'port_closed', port: 3000 } });
    assert({ given: 'object', should: 'parse', actual: readPortsWatchFrame(opened), expected: opened });
  });

  it.each(['not json', '{"type":"other"}', '{"type":"port_list"}', '{"type":"port_opened","port":"5173"}', 42, null])('drops %s', (raw) => {
    assert({ given: String(raw), should: 'be undefined', actual: readPortsWatchFrame(raw), expected: undefined });
  });
});

type Listener = (event: never) => void;

function fakeSocket() {
  const listeners = new Map<string, Listener[]>();
  const closes: Array<[number | undefined, string | undefined]> = [];
  const socket: PortsWatchSocketLike = {
    addEventListener(type: string, listener: Listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    close(code, reason) { closes.push([code, reason]); },
  };
  const emit = (type: string, event?: unknown) => { for (const l of listeners.get(type) ?? []) l(event as never); };
  return { socket, emit, closes };
}

describe('openPortsWatch', () => {
  it('refuses to open without a token — fail closed, no socket created', async () => {
    let created = 0;
    const closes: unknown[] = [];
    openPortsWatch({ url: 'wss://x', token: '', createSocket: () => { created += 1; throw new Error('should not be called'); }, onFrame: () => {}, onClose: (info) => closes.push(info) });
    await new Promise((r) => setImmediate(r));
    assert({ given: 'empty token', should: 'never construct a socket and report no-token', actual: { created, closes }, expected: { created: 0, closes: [{ opened: false, reason: 'no-token' }] } });
  });

  it('sends the bearer token, delivers parsed frames in order, and reports the close once', async () => {
    const fake = fakeSocket();
    let headers: Record<string, string> = {};
    const frames: PortsWatchFrame[] = [];
    const closes: unknown[] = [];
    openPortsWatch({
      url: 'wss://api/x',
      token: 'tok',
      createSocket: (_url, h) => { headers = h; return fake.socket; },
      onFrame: (f) => frames.push(f),
      onClose: (info) => closes.push(info),
    });
    fake.emit('open');
    fake.emit('message', { data: JSON.stringify({ type: 'port_list', ports: [{ port: 1 }] }) });
    fake.emit('message', { data: 'garbage' });
    fake.emit('message', { data: JSON.stringify({ type: 'port_opened', port: 5173, pid: 2 }) });
    fake.emit('error', new Error('x'));
    fake.emit('close', { code: 1006, reason: '' });
    fake.emit('close', { code: 1006, reason: '' });
    assert({ given: 'a live socket', should: 'authorize with the token', actual: headers, expected: { Authorization: 'Bearer tok' } });
    assert({ given: 'three messages, one garbage', should: 'deliver two frames in order', actual: frames, expected: [{ type: 'port_list', ports: [{ port: 1 }] }, { type: 'port_opened', port: 5173, pid: 2 }] });
    assert({ given: 'two close events', should: 'report once, as closed after open', actual: closes, expected: [{ opened: true, code: 1006, reason: 'closed' }] });
  });

  it('reports a refused upgrade (closed before open) distinctly', () => {
    const fake = fakeSocket();
    const closes: unknown[] = [];
    openPortsWatch({ url: 'wss://api/x', token: 't', createSocket: () => fake.socket, onFrame: () => {}, onClose: (info) => closes.push(info) });
    fake.emit('close', { code: 1002 });
    assert({ given: 'close without open', should: 'say refused', actual: closes, expected: [{ opened: false, code: 1002, reason: 'refused' }] });
  });

  it('closing from the caller closes the socket and reports closed-by-caller; later frames are ignored', () => {
    const fake = fakeSocket();
    const frames: unknown[] = [];
    const closes: unknown[] = [];
    const handle = openPortsWatch({ url: 'wss://api/x', token: 't', createSocket: () => fake.socket, onFrame: (f) => frames.push(f), onClose: (info) => closes.push(info) });
    fake.emit('open');
    handle.close();
    handle.close();
    fake.emit('message', { data: JSON.stringify({ type: 'port_opened', port: 1 }) });
    assert({ given: 'caller close', should: 'close the socket once with 1000', actual: fake.closes, expected: [[1000, 'closed-by-caller']] });
    assert({ given: 'caller close', should: 'report once and drop later frames', actual: { closes, frames }, expected: { closes: [{ opened: true, reason: 'closed-by-caller' }], frames: [] } });
  });

  it('reports a constructor failure as a close', async () => {
    const closes: unknown[] = [];
    openPortsWatch({ url: 'wss://api/x', token: 't', createSocket: () => { throw new Error('no ws'); }, onFrame: () => {}, onClose: (info) => closes.push(info) });
    await new Promise((r) => setImmediate(r));
    expect(closes).toEqual([{ opened: false, reason: 'open-failed: no ws' }]);
  });
});
