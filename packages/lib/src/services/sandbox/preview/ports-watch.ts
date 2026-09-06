/**
 * `ports/watch` — the REQUIRED dev-server detection channel (spike §9).
 *
 * `WSS /v1/sprites/{name}/ports/watch` sends a `port_list` snapshot of every
 * bound port on connect, then `port_opened` / `port_closed` for ALL processes
 * in the sprite, TTY or not. The exec-WS `message` channel the merged seam
 * surfaces as `SandboxStream.onPortEvent` is TTY-only (a plain non-TTY
 * `spawn` of a dev server emits NOTHING there — verified twice), so it is
 * SUPERSEDED for detection: a caller fed from it alone silently misses every
 * agent-launched server. The SDK does not wrap this endpoint, so this module
 * opens it directly, against the same API base and bearer token the SDK
 * client holds.
 *
 * This module owns the URL, the frame grammar and the socket lifecycle;
 * what a frame MEANS is the decision core's (`classifyDetectedDevServer`),
 * and what to do about it is the detector's (`dev-preview-detection.ts`).
 * The socket constructor is injected: the realtime tier passes the runtime
 * `WebSocket` (Node ≥ 24, whose constructor honours `{ headers }` — the same
 * fact the Sprites SDK's exec path relies on), tests pass a fake.
 *
 * FAIL CLOSED. The watch channel is the only detection channel. When it
 * cannot be opened — no token, a refused upgrade, a dropped socket past the
 * caller's reconnect budget — nothing is detected, nothing is planned, and
 * the caller is told so (`onClose`). No fallback to the TTY channel, no
 * exec-based port probe (an exec wakes a paused sprite, and a wake is billed).
 *
 * Wire shapes (spike §9): `port_opened`/`port_closed` carry
 * `{port, address: <sprite ip>, pid}` — `address` is never a per-port public
 * URL and is ignored; `port_list` carries `{ports: [{port, pid?}, …]}`.
 * Everything is validated defensively; an unrecognized frame is dropped.
 */

import type { ListeningPort } from './dev-preview-core';
import { readPortNotification, type SpritePortNotification } from '../sandbox-client/sprites';

export type PortsWatchFrame =
  | { type: 'port_list'; ports: ListeningPort[] }
  | SpritePortNotification;

/**
 * The Sprites API base the watch channel is opened against. The SDK client
 * defaults to `https://api.sprites.dev` and accepts a `baseURL` override;
 * `SPRITES_API_URL` is the same override for this endpoint, which the SDK
 * does not wrap. Read directly from `process.env` (realtime's lean env).
 */
export function resolveSpritesApiBaseUrl(): string {
  return process.env.SPRITES_API_URL || 'https://api.sprites.dev';
}

/** Pure: the watch endpoint for a sprite, from the API base the SDK client reports (`https://api.sprites.dev` → `wss://…`). */
export function buildPortsWatchUrl(apiBaseUrl: string, spriteName: string): string {
  const base = new URL(apiBaseUrl);
  base.protocol = base.protocol === 'http:' ? 'ws:' : 'wss:';
  base.pathname = `/v1/sprites/${encodeURIComponent(spriteName)}/ports/watch`;
  base.search = '';
  base.hash = '';
  return base.toString();
}

function readListeningPort(entry: unknown): ListeningPort | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const { port, pid } = entry as { port?: unknown; pid?: unknown };
  if (typeof port !== 'number' || !Number.isInteger(port)) return undefined;
  return { port, ...(typeof pid === 'number' ? { pid } : {}) };
}

/** Pure: parse one raw socket message (string, Buffer, ArrayBuffer or already-parsed object) into a frame, or undefined. */
export function readPortsWatchFrame(raw: unknown): PortsWatchFrame | undefined {
  let message: unknown = raw;
  if (typeof raw === 'string') {
    try {
      message = JSON.parse(raw);
    } catch {
      return undefined;
    }
  } else if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
    try {
      message = JSON.parse((raw instanceof ArrayBuffer ? Buffer.from(raw) : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)).toString('utf8'));
    } catch {
      return undefined;
    }
  }
  if (typeof message !== 'object' || message === null) return undefined;
  const frame = message as { type?: unknown; ports?: unknown };
  if (frame.type === 'port_list') {
    if (!Array.isArray(frame.ports)) return undefined;
    const ports: ListeningPort[] = [];
    for (const entry of frame.ports) {
      const port = readListeningPort(entry);
      if (port) ports.push(port);
    }
    return { type: 'port_list', ports };
  }
  return readPortNotification(message);
}

/** The subset of the WebSocket API the watch needs — satisfied by the runtime `WebSocket` and by a test fake. */
export interface PortsWatchSocketLike {
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: (event: { code?: number; reason?: string }) => void): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
  close(code?: number, reason?: string): void;
}

export type PortsWatchSocketFactory = (url: string, headers: Record<string, string>) => PortsWatchSocketLike;

export interface OpenPortsWatchInput {
  url: string;
  /** The org-minted Sprites token; empty ⇒ the watch is refused before a socket is opened (fail closed). */
  token: string;
  createSocket: PortsWatchSocketFactory;
  onFrame: (frame: PortsWatchFrame) => void;
  /** Fired exactly once, when the channel is gone for any reason. `opened` says whether it ever connected. */
  onClose: (info: { opened: boolean; code?: number; reason: string }) => void;
}

export interface PortsWatchHandle {
  close(): void;
}

/** Open the watch. Frames are delivered in order; malformed frames are dropped silently. */
export function openPortsWatch({ url, token, createSocket, onFrame, onClose }: OpenPortsWatchInput): PortsWatchHandle {
  let closed = false;
  let opened = false;
  const finish = (info: { code?: number; reason: string }) => {
    if (closed) return;
    closed = true;
    onClose({ opened, ...info });
  };

  if (token.length === 0) {
    queueMicrotask(() => finish({ reason: 'no-token' }));
    return { close() { finish({ reason: 'closed-by-caller' }); } };
  }

  let socket: PortsWatchSocketLike;
  try {
    socket = createSocket(url, { Authorization: `Bearer ${token}` });
  } catch (error) {
    queueMicrotask(() => finish({ reason: `open-failed: ${error instanceof Error ? error.message : String(error)}` }));
    return { close() { finish({ reason: 'closed-by-caller' }); } };
  }

  socket.addEventListener('open', () => { opened = true; });
  socket.addEventListener('message', (event) => {
    if (closed) return;
    const frame = readPortsWatchFrame(event.data);
    if (frame) onFrame(frame);
  });
  socket.addEventListener('error', () => {
    // A `close` always follows an error on the WebSocket API; the reason is carried there.
  });
  socket.addEventListener('close', (event) => finish({ code: event.code, reason: event.reason || (opened ? 'closed' : 'refused') }));

  return {
    close() {
      if (closed) return;
      try {
        socket.close(1000, 'closed-by-caller');
      } catch {
        // Already gone.
      }
      finish({ reason: 'closed-by-caller' });
    },
  };
}
