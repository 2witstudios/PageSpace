import * as os from 'node:os';
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';
import nodeMachineId from 'node-machine-id';
import { loadAuthSession, type StoredAuthSession } from './auth-storage';
import { setCachedSession, setCachedMachineId, cachedMachineId, cachedSession } from './state';
import { resolveFallbackDeviceId } from './device-id-fallback';
import { logger } from './logger';

function deviceIdFilePath(): string {
  return path.join(app.getPath('userData'), 'device-id');
}

function readPersistedDeviceId(): string | null {
  try {
    const id = readFileSync(deviceIdFilePath(), 'utf8').trim();
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

function persistDeviceId(id: string): void {
  try {
    writeFileSync(deviceIdFilePath(), id, 'utf8');
  } catch (error) {
    // A write failure is non-fatal: `legacyMachineDerivedId` is deterministic,
    // so the next launch regenerates the identical id (no device-binding churn).
    logger.warn('[Auth] Failed to persist fallback device id', { error });
  }
}

/**
 * The historical fallback deviceId. It is DETERMINISTIC for a given machine,
 * which is exactly why we seed the persisted id from it: an existing install
 * whose device token was bound to this value keeps that binding across the
 * upgrade to the persisted-id scheme (no forced `device_id_mismatch` logout).
 * Persisting it once then makes it stable even if the hostname later changes.
 */
function legacyMachineDerivedId(): string {
  return `${os.hostname()}-${process.platform}-${process.arch}`;
}

export async function preloadAuthSession(): Promise<void> {
  try {
    const session = await loadAuthSession();
    setCachedSession(session);
  } catch (error) {
    logger.error('[Auth] Failed to preload session', { error });
    setCachedSession(null);
  }
}

export function getMachineIdentifier(): string {
  const { machineIdSync } = nodeMachineId;
  const currentCachedId = cachedMachineId;
  if (currentCachedId) {
    return currentCachedId;
  }

  try {
    const id = machineIdSync(true);
    setCachedMachineId(id);
    return id;
  } catch (error) {
    // Persist the deviceId once, then reuse it verbatim — so it stays stable
    // even if the hostname later changes (VPN/network switch), which otherwise
    // flips a recomputed hostname-derived id and triggers a device_id_mismatch
    // 401 → logout. The seed is the legacy machine-derived id so an existing
    // install's token binding survives the upgrade to this scheme.
    logger.warn('[Auth] Failed to read machine identifier, falling back to persisted device id', { error });
    const fallbackId = resolveFallbackDeviceId({
      readPersistedId: readPersistedDeviceId,
      persistId: persistDeviceId,
      seedId: legacyMachineDerivedId,
    });
    setCachedMachineId(fallbackId);
    return fallbackId;
  }
}

export async function getOrLoadSession(): Promise<StoredAuthSession | null> {
  if (cachedSession === undefined) {
    await preloadAuthSession();
  }
  return cachedSession ?? null;
}
