import * as os from 'node:os';
import nodeMachineId from 'node-machine-id';
import { loadAuthSession, type StoredAuthSession } from './auth-storage';
import { setCachedSession, setCachedMachineId, cachedMachineId, cachedSession } from './state';
import { logger } from './logger';

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
    logger.warn('[Auth] Failed to read machine identifier, falling back to hostname', { error });
    const fallbackId = `${os.hostname()}-${process.platform}-${process.arch}`;
    setCachedMachineId(fallbackId);
    return fallbackId;
  }
}

export function getCachedSession(): StoredAuthSession | null | undefined {
  return cachedSession;
}

export async function getOrLoadSession(): Promise<StoredAuthSession | null> {
  if (cachedSession === undefined) {
    await preloadAuthSession();
  }
  return cachedSession ?? null;
}
