import { dialog, app } from 'electron';
import electronUpdaterPkg from 'electron-updater';
import { setIsQuitting } from './state';
import { destroyTray } from './tray';
import { APP_IDENTITY } from '../shared/current-app-identity';

const { autoUpdater } = electronUpdaterPkg;

export function setupAutoUpdater(): void {
  // Only PageSpace has a publish feed (see the electron-builder configs). Left
  // ungated, every coder launch would poll a release channel that does not
  // exist and surface the failure to the user.
  if (APP_IDENTITY.variant !== 'pagespace') return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.checkForUpdatesAndNotify();

  const CHECK_INTERVAL = 4 * 60 * 60 * 1000;
  setInterval(() => {
    autoUpdater.checkForUpdates();
  }, CHECK_INTERVAL);

  autoUpdater.on('update-available', (info) => {
    console.log('Update available:', info.version);
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Available',
      message: `A new version (${info.version}) is available and is being downloaded.`,
      detail: 'You will be notified when the download is complete.',
      buttons: ['OK'],
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('Update downloaded:', info.version);
    dialog
      .showMessageBox({
        type: 'info',
        title: 'Update Ready',
        message: `Version ${info.version} has been downloaded and is ready to install.`,
        detail: `The update will be installed the next time you restart ${APP_IDENTITY.displayName}.`,
        buttons: ['Restart Now', 'Later'],
        defaultId: 1,
        cancelId: 1,
      })
      .then((result) => {
        if (result.response === 0) {
          setIsQuitting(true);
          destroyTray();
          autoUpdater.quitAndInstall(false, true);
        }
      });
  });

  autoUpdater.on('error', (error) => {
    console.error('Auto-updater error:', error);
  });

  autoUpdater.on('checking-for-update', () => {
    console.log('Checking for updates...');
  });

  autoUpdater.on('update-not-available', () => {
    console.log('No updates available');
  });
}

export function checkForUpdates(): void {
  autoUpdater
    .checkForUpdates()
    .then((result) => {
      if (!result || !result.updateInfo) {
        dialog.showMessageBox({
          type: 'info',
          title: 'No Updates',
          message: `You are running the latest version of ${APP_IDENTITY.displayName}.`,
          buttons: ['OK'],
        });
        return;
      }

      const currentVersion = app.getVersion();
      const latestVersion = result.updateInfo.version;

      if (currentVersion === latestVersion) {
        dialog.showMessageBox({
          type: 'info',
          title: 'No Updates',
          message: `You are running the latest version of ${APP_IDENTITY.displayName}.`,
          buttons: ['OK'],
        });
      }
    })
    .catch((error) => {
      console.error('Update check failed:', error);
      dialog.showMessageBox({
        type: 'error',
        title: 'Update Check Failed',
        message: 'Unable to check for updates. Please try again later.',
        detail: error.message || 'Unknown error occurred',
        buttons: ['OK'],
      });
    });
}
