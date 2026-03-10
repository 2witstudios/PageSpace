import { powerMonitor } from 'electron';
import { mainWindow, isSuspended, suspendTime, setIsSuspended, setSuspendTime, setCachedSession } from './state';
import { preloadAuthSession } from './auth-session';
import { logger } from './logger';

export function setupPowerMonitor(): void {
  powerMonitor.on('suspend', () => {
    setIsSuspended(true);
    setSuspendTime(Date.now());
    logger.info('[Power] System suspending - pausing auth refresh');

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('power:suspend', { suspendTime: Date.now() });
    }
  });

  powerMonitor.on('resume', () => {
    const resumeTime = Date.now();
    const currentSuspendTime = suspendTime;
    const sleepDuration = currentSuspendTime ? resumeTime - currentSuspendTime : 0;

    logger.info('[Power] System resumed', {
      sleepDurationMs: sleepDuration,
      sleepDurationMin: Math.round(sleepDuration / 60000),
    });

    setIsSuspended(false);

    setCachedSession(undefined);
    preloadAuthSession();

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('power:resume', {
        resumeTime,
        sleepDuration,
        forceRefresh: sleepDuration > 5 * 60 * 1000,
      });
    }

    setSuspendTime(null);
  });

  powerMonitor.on('lock-screen', () => {
    logger.debug('[Power] Screen locked');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('power:lock-screen');
    }
  });

  powerMonitor.on('unlock-screen', () => {
    logger.debug('[Power] Screen unlocked');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('power:unlock-screen', {
        shouldRefresh: true,
      });
    }
  });

  powerMonitor.on('on-ac', () => {
    logger.debug('[Power] On AC power');
  });

  powerMonitor.on('on-battery', () => {
    logger.debug('[Power] On battery power');
  });

  if (process.platform === 'darwin') {
    powerMonitor.on('thermal-state-change', (details) => {
      logger.debug('[Power] Thermal state changed', { state: details.state });
    });
  }

  logger.info('[Power] Power monitor initialized');
}

export function getPowerState(): {
  isSuspended: boolean;
  suspendTime: number | null;
  systemIdleTime: number;
} {
  return {
    isSuspended,
    suspendTime,
    systemIdleTime: powerMonitor.getSystemIdleTime(),
  };
}

export { isSuspended, suspendTime };
