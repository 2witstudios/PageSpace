import { describe, it } from 'vitest';

// Threat model A6, A7, Λ7 (ASI02/ASI09). G6a/G6b/G6c cases; the harness counts agent-visible events during human control.

describe('adversarial: browser-read-back', () => {
  it.todo('given human-control mode, should report agent-visible event count 0 across a scripted 60 s session (screencast, a11y, read, clipboard all cut) — I/O row, owned by G6a/G6b/G6c (browser worker: observation blackout and typed tools)');
  it.todo('given a fill operation, should report agent-visible event count 0 across the fill blackout — I/O row, owned by G6a/G6b/G6c (browser worker: observation blackout and typed tools)');
  it.todo('given a page that copies the filled input into a text node, should not expose it to the agent read surface (observation still cut; resume in a clean context) — I/O row, owned by G6a/G6b/G6c (browser worker: observation blackout and typed tools)');
  it.todo('given a typed action whose target frame origin is outside allowedOrigins at the moment of use, should refuse (frame origin checked atomically) — I/O row, owned by G6a/G6b/G6c (browser worker: observation blackout and typed tools)');
  it.todo('given the agent Sprite, should be unable to reach the browser Sprite CDP (no port), profile directory, cookie store, or *.sprites.app URL without the org token — I/O row, owned by G6a/G6b/G6c (browser worker: observation blackout and typed tools)');
  it.todo('given capture, should include only allowed + auxiliary origins in the declared format; whole profiles never stored — I/O row, owned by G6a/G6b/G6c (browser worker: observation blackout and typed tools)');
});
