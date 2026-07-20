/**
 * Functional core for the desktop deviceId fallback.
 *
 * When `machineIdSync` is unavailable, the desktop app must still produce a
 * STABLE deviceId. The previous fallback derived it from `os.hostname()`, which
 * flips when the machine's hostname changes (VPN/network switch on macOS). A
 * flipped deviceId no longer matches the device-token binding, so the server
 * returns a `device_id_mismatch` 401 and the user is logged out.
 *
 * This resolver instead reuses a persisted UUID — generated once and stored under
 * userData — so the deviceId is invariant across launches and network changes.
 * All I/O is injected so the decision is unit-testable without Electron or a disk.
 */

export interface DeviceIdFallbackDeps {
  /** Read the persisted deviceId, or null if none has been stored yet. */
  readPersistedId: () => string | null;
  /** Persist a freshly-generated deviceId for future launches. */
  persistId: (id: string) => void;
  /** Generate a new opaque, stable deviceId (e.g. a UUID). */
  generateId: () => string;
}

/**
 * Resolve a stable fallback deviceId: reuse the persisted one if present,
 * otherwise generate one, persist it, and return it. Never derives the id from
 * volatile machine state such as the hostname.
 */
export function resolveFallbackDeviceId(deps: DeviceIdFallbackDeps): string {
  const existing = deps.readPersistedId();
  if (existing) {
    return existing;
  }

  const generated = deps.generateId();
  deps.persistId(generated);
  return generated;
}
