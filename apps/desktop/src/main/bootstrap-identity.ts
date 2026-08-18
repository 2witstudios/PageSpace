import { app } from 'electron';
import * as path from 'path';
import { APP_IDENTITY } from '../shared/current-app-identity';

/**
 * Establish this build's OS-level identity before anything else runs.
 *
 * MUST be imported first by `src/main/index.ts`. `app.getName()` decides
 * `app.getPath('userData')`, which in turn decides where the electron-store
 * config, the encrypted auth session, the device id and the MCP config live —
 * and modules like `./store` construct their singletons at import time, so a
 * later call would come too late to move them.
 *
 * Packaged, electron-builder's `productName` already gives each app its own
 * userData directory, single-instance lock and `safeStorage` keychain entry.
 * Under `electron-vite dev` both variants would otherwise report the same
 * default name and share all of it, so development gets an explicit split — a
 * coder dev session must not be able to overwrite a PageSpace login.
 */
app.setName(APP_IDENTITY.productName);

if (!app.isPackaged) {
  app.setPath(
    'userData',
    path.join(app.getPath('appData'), `${APP_IDENTITY.productName} (dev)`),
  );
}
