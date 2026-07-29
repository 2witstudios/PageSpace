/**
 * The agent-dispatch chain depth, carried across the internal HTTP hop.
 *
 * A worker spawned by `spawn_session`/`send_session` runs its turn through the
 * SAME chat routes a human turn uses, so the only way the chain depth survives
 * that hop is a header. Both routes read it and fold it back into the tool
 * context, where `MAX_AGENT_DEPTH` terminates an A→B→C chain.
 *
 * Extracted because the parse/clamp was duplicated byte-for-byte in two routes.
 * It is small, but it is the termination condition of a recursive system: if the
 * two copies ever drift — one accepting a value the other rejects — the cap stops
 * being a cap on one path, and nothing in the type system would say so.
 *
 * **Untrusted by design, and safe untrusted.** The header is client-settable and
 * deliberately not signed, because neither direction of forgery helps an
 * attacker: forging it LOW yields 0, which is exactly the default any client
 * already gets; forging it HIGH only brings the forger closer to their own cap.
 * Everything non-integer, negative, fractional, or absent collapses to 0 — the
 * value a request with no dispatch history should have.
 */

export const AGENT_DISPATCH_DEPTH_HEADER = 'X-Agent-Dispatch-Depth';

/**
 * Parse the raw header value into a non-negative integer. Internal: callers get
 * `readAgentDispatchDepth`, so there is exactly one way to obtain a depth and no
 * second entry point that could grow a different clamp.
 */
function parseAgentDispatchDepth(raw: string | null | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

/** Read and clamp the depth straight off a request's headers. */
export function readAgentDispatchDepth(headers: Headers): number {
  return parseAgentDispatchDepth(headers.get(AGENT_DISPATCH_DEPTH_HEADER));
}
