import { app, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import * as path from 'path';
import { decodeJwt } from 'jose';
import { logger } from './logger';

export interface StoredAuthSession {
  accessToken: string;
  refreshToken: string;
  csrfToken?: string | null;
  deviceToken?: string | null;
}

let authSessionPath: string | null = null;

function ensureAuthSessionPath(): string {
  if (!authSessionPath) {
    if (!app.isReady()) {
      throw new Error('Application not ready to resolve userData path');
    }
    authSessionPath = path.join(app.getPath('userData'), 'auth-session.bin');
  }
  return authSessionPath;
}

export async function saveAuthSession(sessionData: StoredAuthSession): Promise<void> {
  try {
    const payload = JSON.stringify(sessionData);
    const encryptionAvailable = safeStorage.isEncryptionAvailable();
    const encrypted = encryptionAvailable
      ? safeStorage.encryptString(payload)
      : Buffer.from(payload, 'utf8');

    await fs.writeFile(ensureAuthSessionPath(), encrypted);
    logger.info('[Auth] Session stored securely', {
      encrypted: encryptionAvailable,
      payloadSize: payload.length,
    });
  } catch (error) {
    logger.error('[Auth] Failed to persist session', {
      error,
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
    });
    throw error;
  }
}

export async function loadAuthSession(): Promise<StoredAuthSession | null> {
  try {
    const filePath = ensureAuthSessionPath();
    const raw = await fs.readFile(filePath);

    let session: StoredAuthSession;

    // FIX: Always try decryption first, regardless of isEncryptionAvailable()
    // On macOS, isEncryptionAvailable() can return different values at different times
    // (Keychain lock state, app launched before login, code signing issues, etc.)
    // If we saved encrypted but isEncryptionAvailable() returns false on load,
    // we'd skip decryption and corrupt the data.
    try {
      // Try decryption first - this handles:
      // 1. Encrypted data when safeStorage is available (normal case)
      // 2. Encrypted data when safeStorage reports unavailable (the bug case)
      const decoded = safeStorage.decryptString(raw);
      session = JSON.parse(decoded) as StoredAuthSession;
      logger.debug('[Auth] Session decrypted successfully');
    } catch (decryptError) {
      // Decryption failed - could be:
      // 1. Plain text data (saved when encryption was unavailable)
      // 2. Keychain locked/unavailable but data is valid encrypted
      // 3. Corrupted data
      const encryptionAvailable = safeStorage.isEncryptionAvailable();
      logger.debug('[Auth] Decryption failed, attempting plain text parse', {
        error: decryptError instanceof Error ? decryptError.message : String(decryptError),
        encryptionAvailable,
      });

      try {
        const decoded = raw.toString('utf8');
        session = JSON.parse(decoded) as StoredAuthSession;
        logger.debug('[Auth] Plain text session loaded successfully');
      } catch (parseError) {
        // Data is neither valid decrypted nor valid plain text JSON
        // IMPORTANT: Only delete if we're confident it's truly corrupted.
        // If encryption is unavailable (Keychain locked), the file might contain
        // valid encrypted data that will decrypt once Keychain becomes available.
        if (encryptionAvailable) {
          // Encryption IS available but both decrypt and plain text failed = truly corrupted
          logger.error('[Auth] Session file is corrupted - deleting for clean re-login', {
            rawLength: raw.length,
            firstBytes: raw.subarray(0, 20).toString('hex'),
          });
          try {
            await fs.unlink(filePath);
            logger.info('[Auth] Corrupted session file deleted');
          } catch (unlinkError) {
            logger.warn('[Auth] Failed to delete corrupted session file', {
              error: unlinkError instanceof Error ? unlinkError.message : String(unlinkError),
            });
          }
        } else {
          // Encryption unavailable - file might be valid encrypted data waiting for Keychain
          // Don't delete; return null and let user retry when Keychain is available
          logger.warn('[Auth] Cannot load session - Keychain may be locked. Keeping file for retry.', {
            rawLength: raw.length,
          });
        }
        return null;
      }
    }

    // Validate token expiry before returning
    if (session.accessToken) {
      try {
        const payload = decodeJwt(session.accessToken);
        const now = Math.floor(Date.now() / 1000);

        // Check if access token is expired (with 30 second buffer)
        if (payload.exp && payload.exp < now + 30) {
          logger.info('[Auth] Access token expired or expiring soon, session will auto-refresh');
          // Don't return null - let the app load and auto-refresh will handle it
          // This prevents unnecessary logouts when tokens just need refreshing
        }
      } catch (error) {
        logger.warn('[Auth] Failed to decode access token', { error });
        // Token might be malformed, but let the app try to use it
        // The server will reject it if invalid, triggering refresh
      }
    }

    return session;
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    logger.error('[Auth] Failed to load session', { error });
    return null;
  }
}

export async function clearAuthSession(): Promise<void> {
  try {
    await fs.unlink(ensureAuthSessionPath());
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      logger.error('[Auth] Failed to clear stored session', { error });
    }
  }
}
