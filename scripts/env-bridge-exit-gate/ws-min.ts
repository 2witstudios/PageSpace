/**
 * A minimal, dependency-free WebSocket layer for the exit-gate harness.
 *
 * The harness lives in the ROOT workspace, whose only relevant dependency is
 * `@pagespace/lib`. Importing `ws` here would be an unlisted dependency and
 * `knip:check` (blocking in CI) would fail on it, so this implements exactly
 * the slice the gate needs and nothing more:
 *
 *   - a CLIENT handshake with arbitrary headers (`Authorization: Bearer …`,
 *     which the platform's global `WebSocket` cannot send), over `node:net`
 *     or `node:tls`;
 *   - a SERVER-side upgrade accept, so the capture proxy can be what the
 *     daemon dials;
 *   - text-frame encode/decode with the masking rules RFC 6455 requires
 *     (client→server masked, server→client not), continuation frames
 *     reassembled, and ping answered with pong so a long capture is not
 *     dropped by the app's heartbeat.
 *
 * Binary frames are not used by the bridge (the codec is JSON text), so they
 * are surfaced as errors rather than silently decoded — this is a test
 * harness, and a surprise on the wire must be visible.
 */
import { createHash, randomBytes } from 'node:crypto';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const acceptValueFor = (key: string): string => createHash('sha1').update(`${key}${GUID}`).digest('base64');

const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;

/** Encode one complete text/control frame. `mask` is required for client→server frames. */
function encode(opcode: number, payload: Buffer, mask: boolean): Buffer {
  const head: number[] = [0x80 | opcode];
  const length = payload.length;
  const lengthBytes: number[] = [];
  if (length < 126) head.push((mask ? 0x80 : 0) | length);
  else if (length < 65536) {
    head.push((mask ? 0x80 : 0) | 126);
    lengthBytes.push((length >> 8) & 0xff, length & 0xff);
  } else {
    head.push((mask ? 0x80 : 0) | 127);
    for (let i = 7; i >= 0; i -= 1) lengthBytes.push(Number((BigInt(length) >> BigInt(8 * i)) & 0xffn));
  }
  const parts = [Buffer.from([...head, ...lengthBytes])];
  if (mask) {
    const key = randomBytes(4);
    const masked = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i += 1) masked[i] = (payload[i] as number) ^ (key[i % 4] as number);
    parts.push(key, masked);
  } else {
    parts.push(payload);
  }
  return Buffer.concat(parts);
}

/**
 * One end of an established WebSocket. `masked` says which side this is:
 * a client masks what it sends, a server does not.
 */
export class MinSocket extends EventEmitter {
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  private closed = false;

  private readonly socket: Socket;
  private readonly masked: boolean;

  // Written out rather than declared as TypeScript parameter properties: the
  // harness runs under `node --experimental-strip-types`, whose strip-only
  // mode refuses them, and the proxy MUST run under node (Bun 1.3.14's
  // node:http emits `upgrade` with a socket whose writes never reach the
  // client, so the 101 is swallowed and the daemon sees a hang-up).
  constructor(socket: Socket, masked: boolean) {
    super();
    this.socket = socket;
    this.masked = masked;
    socket.on('data', (chunk: Buffer) => this.ingest(chunk));
    socket.on('close', () => this.finish(1006, 'transport closed'));
    socket.on('error', (error: Error) => this.emit('error', error));
  }

  get isOpen(): boolean {
    return !this.closed && !this.socket.destroyed;
  }

  send(text: string): void {
    if (this.isOpen) this.socket.write(encode(OPCODE.text, Buffer.from(text, 'utf8'), this.masked));
  }

  close(code = 1000, reason = ''): void {
    if (!this.isOpen) return;
    const payload = Buffer.concat([Buffer.from([(code >> 8) & 0xff, code & 0xff]), Buffer.from(reason, 'utf8')]);
    this.socket.write(encode(OPCODE.close, payload, this.masked));
    this.socket.end();
    this.finish(code, reason);
  }

  private finish(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', code, reason);
  }

  private ingest(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = this.take();
      if (frame === null) return;
      this.dispatch(frame.opcode, frame.fin, frame.payload);
    }
  }

  /** Pull one whole frame off the buffer, or `null` when more bytes are needed. */
  private take(): { opcode: number; fin: boolean; payload: Buffer } | null {
    if (this.buffer.length < 2) return null;
    const first = this.buffer[0] as number;
    const second = this.buffer[1] as number;
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const isMasked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (this.buffer.length < offset + 2) return null;
      length = this.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (this.buffer.length < offset + 8) return null;
      length = Number(this.buffer.readBigUInt64BE(offset));
      offset += 8;
    }
    const maskKey = isMasked ? this.buffer.subarray(offset, offset + 4) : null;
    if (isMasked) offset += 4;
    if (this.buffer.length < offset + length) return null;
    const raw = Buffer.from(this.buffer.subarray(offset, offset + length));
    this.buffer = this.buffer.subarray(offset + length);
    if (maskKey !== null) {
      for (let i = 0; i < raw.length; i += 1) raw[i] = (raw[i] as number) ^ (maskKey[i % 4] as number);
    }
    return { opcode, fin, payload: raw };
  }

  private dispatch(opcode: number, fin: boolean, payload: Buffer): void {
    if (opcode === OPCODE.close) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      this.finish(code, payload.subarray(2).toString('utf8'));
      this.socket.end();
      return;
    }
    if (opcode === OPCODE.ping) {
      if (this.isOpen) this.socket.write(encode(OPCODE.pong, payload, this.masked));
      return;
    }
    if (opcode === OPCODE.pong) return;
    if (opcode === OPCODE.binary) {
      this.emit('error', new Error('unexpected binary frame: the bridge codec is JSON text'));
      return;
    }
    if (opcode === OPCODE.text || opcode === OPCODE.continuation) {
      if (opcode === OPCODE.text) {
        this.fragments = [];
        this.fragmentOpcode = OPCODE.text;
      }
      this.fragments.push(payload);
      if (!fin) return;
      const text = Buffer.concat(this.fragments).toString('utf8');
      this.fragments = [];
      if (this.fragmentOpcode === OPCODE.text) this.emit('message', text);
    }
  }
}

/** Open a client WebSocket to `url` with the given headers. Rejects on anything but a 101. */
export function openClient(url: string, headers: Readonly<Record<string, string>> = {}): Promise<MinSocket> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const secure = target.protocol === 'wss:';
    const port = target.port === '' ? (secure ? 443 : 80) : Number(target.port);
    const key = randomBytes(16).toString('base64');
    const socket = secure
      ? tlsConnect({ host: target.hostname, port, servername: target.hostname })
      : netConnect({ host: target.hostname, port });

    let banner = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      banner = Buffer.concat([banner, chunk]);
      const end = banner.indexOf('\r\n\r\n');
      if (end === -1) return;
      const head = banner.subarray(0, end).toString('utf8');
      socket.removeListener('data', onData);
      const statusLine = head.split('\r\n')[0] ?? '';
      if (!statusLine.includes(' 101 ')) {
        socket.destroy();
        reject(new Error(`upgrade refused: ${statusLine}`));
        return;
      }
      const rest = banner.subarray(end + 4);
      const wrapped = new MinSocket(socket, true);
      resolve(wrapped);
      // Bytes that arrived in the same packet as the handshake are real frames.
      if (rest.length > 0) socket.emit('data', rest);
    };
    socket.on('data', onData);
    socket.on('error', reject);
    socket.on('connect', () => {
      const lines = [
        `GET ${target.pathname}${target.search} HTTP/1.1`,
        `Host: ${target.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        ...Object.entries(headers)
          .filter(([, value]) => value !== '')
          .map(([name, value]) => `${name}: ${value}`),
        '',
        '',
      ];
      socket.write(lines.join('\r\n'));
    });
    if (secure) socket.on('secureConnect', () => socket.emit('connect'));
  });
}

/** Complete a server-side upgrade on an already-received request and return this end of it. */
export function acceptUpgrade(socket: Socket, secWebSocketKey: string, head: Buffer): MinSocket {
  socket.write(
    ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptValueFor(secWebSocketKey)}`, '', ''].join('\r\n'),
  );
  const wrapped = new MinSocket(socket, false);
  if (head.length > 0) socket.emit('data', head);
  return wrapped;
}
