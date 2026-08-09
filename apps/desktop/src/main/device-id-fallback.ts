/**
 * Functional core for the desktop deviceId fallback.
 *
 * When `machineIdSync` is unavailable, the desktop app must still produce a
 * deviceId that is STABLE across launches. The previous fallback recomputed
 * `${hostname}-${platform}-${arch}` on every call, so it flipped when the
 * machine's hostname changed (VPN/network switch on macOS). A flipped deviceId
 * no longer matches the device-token binding, so the server returns a
 * `device_id_mismatch` 401 and the user is logged out.
 *
 * This resolver makes the id stable by persisting it once and reusing it
 * verbatim thereafter. Stability comes from the persist-once step, NOT from the
 * seed value being hostname-independent — which is why the injected `seedId`
 * MUST be deterministic (see below). All I/O is injected so the decision is
 * unit-testable without Electron or a disk.
 */

export interface DeviceIdFallbackDeps {
  /** Read the persisted deviceId, or null if none has been stored yet. */
  readPersistedId: () => string | null;
  /** Persist the seeded deviceId so future launches read it back verbatim. */
  persistId: (id: string) => void;
  /**
   * Produce the seed deviceId on first run. This value MUST be DETERMINISTIC
   * (e.g. the legacy `${hostname}-${platform}-${arch}` id) rather than random,
   * so that:
   *  - it MATCHES any device token already bound to the legacy fallback before
   *    this persisted-id scheme existed (upgrade continuity — no forced logout);
   *  - if persistence fails, the next launch regenerates the IDENTICAL value
   *    instead of churning a new id every launch (which would itself trigger
   *    repeated `device_id_mismatch` logouts).
   */
  seedId: () => string;
}

/**
 * Resolve a stable fallback deviceId: reuse the persisted one if present,
 * otherwise seed it (from the deterministic `seedId`), persist it for future
 * launches, and return it.
 */
export function resolveFallbackDeviceId(deps: DeviceIdFallbackDeps): string {
  const existing = deps.readPersistedId();
  if (existing) {
    return existing;
  }

  const seeded = deps.seedId();
  deps.persistId(seeded);
  return seeded;
}
