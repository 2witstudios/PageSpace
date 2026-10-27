/**
 * Production `WaitMs` adapters — the only two `setTimeout` wirings in the
 * package, split by whether the pending timer is allowed to keep the Node
 * process alive. Mirrors `open-browser.ts`'s adapter convention (which
 * already `unref()`s its spawned child for the same reason).
 */
import type { WaitMs } from './loopback-flow.js';

/**
 * Ref'd delay — for sequential poll loops (the device flow's
 * `poll-device-token.ts` / `device-flow.ts`), where the timer between polls
 * is often the ONLY live handle and therefore MUST keep the process alive,
 * or the CLI would exit mid-poll before the user ever approves the device.
 */
export const waitMs: WaitMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Unref'd delay — for the timeout arm of `runLoopbackLogin`'s
 * `Promise.race` against the loopback callback. `Promise.race` never cancels
 * its loser: when the callback wins, a ref'd 5-minute timer would go on
 * pinning the event loop long after a successful login, hanging the CLI at
 * exit (`bin.ts` deliberately never force-exits a finished command's
 * pending handles away on its own — see `flushAndExit`'s gate there). The
 * timeout itself still works: while the race is pending the loopback HTTP
 * server is a live ref'd handle, and an unref'd timer still fires as long
 * as the process is alive — it just stops being a reason to stay alive.
 */
export const unrefWaitMs: WaitMs = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
