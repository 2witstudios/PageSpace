import { session, systemPreferences } from 'electron';
import { isMediaPermission, shouldAllowMediaPermission } from './permissions';
import { getAppUrl } from './app-url';
import { logger } from './logger';

function shouldRequestMicrophone(permission: string, details: Electron.PermissionRequest): boolean {
  if (permission === 'audioCapture') return true;
  if (permission !== 'media') return false;

  if (!('mediaTypes' in details)) {
    return true;
  }

  if (!Array.isArray(details.mediaTypes) || details.mediaTypes.length === 0) {
    return true;
  }

  return details.mediaTypes.includes('audio');
}

function shouldRequestCamera(permission: string, details: Electron.PermissionRequest): boolean {
  if (permission === 'videoCapture') return true;
  if (permission !== 'media') return false;
  if (!('mediaTypes' in details)) return false;
  return Array.isArray(details.mediaTypes) && details.mediaTypes.includes('video');
}

async function requestDarwinMediaAccess(
  permission: string,
  details: Electron.PermissionRequest
): Promise<boolean> {
  if (process.platform !== 'darwin') return true;

  const needsMicrophone = shouldRequestMicrophone(permission, details);
  const needsCamera = shouldRequestCamera(permission, details);

  let microphoneAllowed = true;
  let cameraAllowed = true;

  if (needsMicrophone) {
    const micStatus = systemPreferences.getMediaAccessStatus('microphone');
    microphoneAllowed = micStatus === 'granted'
      ? true
      : await systemPreferences.askForMediaAccess('microphone');
  }

  if (needsCamera) {
    const cameraStatus = systemPreferences.getMediaAccessStatus('camera');
    cameraAllowed = cameraStatus === 'granted'
      ? true
      : await systemPreferences.askForMediaAccess('camera');
  }

  return microphoneAllowed && cameraAllowed;
}

export function setupMediaPermissionHandlers(): void {
  const defaultSession = session.defaultSession;

  defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    if (!isMediaPermission(permission)) {
      return true;
    }

    const allowed = shouldAllowMediaPermission(permission, requestingOrigin, getAppUrl());
    if (!allowed) {
      logger.warn('[Permissions] Blocked media permission check', { permission, requestingOrigin });
    }
    return allowed;
  });

  defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    if (!isMediaPermission(permission)) {
      callback(true);
      return;
    }

    const requestingUrl = details.requestingUrl || ('securityOrigin' in details ? details.securityOrigin || '' : '');
    const allowedByOrigin = shouldAllowMediaPermission(permission, requestingUrl, getAppUrl());

    if (!allowedByOrigin) {
      logger.warn('[Permissions] Blocked media permission request (origin mismatch)', {
        permission,
        requestingUrl,
      });
      callback(false);
      return;
    }

    void (async () => {
      const platformAllowed = await requestDarwinMediaAccess(permission, details);
      if (!platformAllowed) {
        logger.warn('[Permissions] Blocked media permission request (platform denied)', {
          permission,
          requestingUrl,
        });
      }
      callback(platformAllowed);
    })().catch((error) => {
      logger.error('[Permissions] Failed handling media permission request', { permission, error });
      callback(false);
    });
  });
}
