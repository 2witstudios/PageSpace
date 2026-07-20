import { randomUUID } from 'node:crypto';
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
    logger.warn('[Auth] Failed to persist fallback device id', { error });
  }
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
    // Do NOT derive the fallback from the hostname — it flips on network/VPN
    // changes and triggers a device_id_mismatch 401 → logout. Use a persisted
    // UUID that is stable across launches and hostname changes.
    logger.warn('[Auth] Failed to read machine identifier, falling back to persisted device id', { error });
    const fallbackId = resolveFallbackDeviceId({
      readPersistedId: readPersistedDeviceId,
      persistId: persistDeviceId,
      generateId: randomUUID,
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
