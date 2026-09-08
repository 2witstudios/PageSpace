/**
 * port-probe — ask the sandbox what is ACTUALLY listening.
 *
 * The `ports/watch` channel is the cheap, passive detection source and it
 * stays the default. But it is positive-only evidence (see
 * {@link ListenerSource}): verified against a real sprite, it never reports a
 * Next.js dev server's bind at all. This module is the authoritative second
 * opinion — a direct read of the sprite's listening sockets — and it is the
 * ONLY thing in the system licensed to say a port is *not* listening.
 *
 * WHEN IT MAY RUN. An exec wakes a paused sprite, and a wake is billed
 * (spike §6), which is why `ports-watch.ts` forbids probing as a fallback and
 * why rendering must be free. Nothing here changes that: this probe runs ONLY
 * on an explicit user gesture — opening the ports list, or picking a port —
 * behind the same wake gate that already guards resume and approve. It must
 * never be reached from a render, a poll, or a detector frame.
 *
 * WHY THE RESULT IS NOT AN ARRAY. A failed probe returning `[]` would read as
 * "nothing is bound", which the core would take as "8080 is free" and start a
 * relay blind — precisely the failure `slot-unknown` exists to prevent, let in
 * through a new door. So failure is a distinct shape a caller cannot
 * accidentally treat as data, and it maps back to `listenerSource: 'watch'`
 * (silence proves nothing) rather than to an empty probe.
 */

import type { ListeningPort } from './dev-preview-core';
import type { RunCommandArgs, SandboxRunResult } from '../sandbox-client/types';

/** Bounded: this runs inside the holder's advisory lock on the select path. */
export const PORT_PROBE_TIMEOUT_MS = 5_000;
/** `ss` output for a sandbox is a few KB; anything past this is not output we understand. */
export const PORT_PROBE_MAX_BYTES = 256 * 1024;

export type PortProbeFailure =
  /** No usable tool in the image, or the command could not run at all. */
  | 'unavailable'
  /** The command was killed at {@link PORT_PROBE_TIMEOUT_MS}. */
  | 'timed-out'
  /** It ran, but nothing in the output parsed as a listening socket. */
  | 'unparsable';

export type PortProbeResult =
  | { ok: true; ports: ListeningPort[] }
  | { ok: false; reason: PortProbeFailure };

/**
 * `-p` is load-bearing, not decoration: without pids `describeHttpPortSlot`
 * cannot tell our own relay from a user process holding 8080, and
 * `DevPreviewSlotReport.pid` would be permanently null. `-n` keeps ports
 * numeric so nothing has to un-resolve a service name.
 */
const PROBE_COMMAND = 'ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null';

/**
 * Pure: parse `ss -ltnp` / `netstat -ltnp` output into listening ports.
 *
 * Split out from the exec so the parsing is testable against real captured
 * output without a sandbox. Defensive by construction — a line that does not
 * yield a port in range is skipped rather than guessed at, and the caller
 * decides what "nothing parsed" means.
 */
export function parseListeningPorts(stdout: string): ListeningPort[] {
  const byPort = new Map<number, ListeningPort>();
  for (const line of stdout.split('\n')) {
    if (!/^\s*(LISTEN|tcp)/i.test(line)) continue;
    // Local Address:Port is the 4th column for `ss`, and IPv6 addresses carry
    // their own colons (`[::]:3000`, `*:3000`), so the PORT is whatever
    // follows the LAST colon of that column.
    const columns = line.trim().split(/\s+/);
    const local = columns[3];
    if (local === undefined) continue;
    const port = Number(local.slice(local.lastIndexOf(':') + 1));
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const pidMatch = /pid=(\d+)/.exec(line);
    const pid = pidMatch ? Number(pidMatch[1]) : undefined;
    // A port bound on both IPv4 and IPv6 appears twice; keep the first, and
    // prefer an entry that carries a pid over one that does not.
    const existing = byPort.get(port);
    if (existing === undefined || (existing.pid === undefined && pid !== undefined)) {
      byPort.set(port, pid === undefined ? { port } : { port, pid });
    }
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

/**
 * Run the probe. Never throws: every failure is a named reason the caller can
 * put in front of a user, because "we could not look" and "nothing is there"
 * are different sentences and only one of them is safe to act on.
 */
export async function probeListeningPorts(
  exec: (args: RunCommandArgs) => Promise<SandboxRunResult>,
): Promise<PortProbeResult> {
  let result: SandboxRunResult;
  try {
    result = await exec({
      cmd: 'sh',
      args: ['-c', PROBE_COMMAND],
      timeoutMs: PORT_PROBE_TIMEOUT_MS,
      maxBytes: PORT_PROBE_MAX_BYTES,
    });
  } catch (error) {
    // The driver SIGKILLs at the cap and surfaces it as a throw; anything else
    // is a control-plane failure. Neither is evidence about ports.
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    return { ok: false, reason: message.includes('timeout') || message.includes('timed out') ? 'timed-out' : 'unavailable' };
  }
  const ports = parseListeningPorts(result.stdout);
  if (ports.length > 0) return { ok: true, ports };
  // Nothing parsed. A sandbox with genuinely nothing listening is real and
  // common, so distinguish it from a broken command by the exit code: `ss`
  // succeeding with no rows is an honest empty answer.
  if (result.exitCode === 0) return { ok: true, ports: [] };
  return { ok: false, reason: 'unavailable' };
}
