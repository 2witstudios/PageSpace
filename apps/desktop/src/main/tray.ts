import { Menu, Tray, nativeImage, app } from 'electron';
import * as path from 'path';
import { mainWindow, setTray, tray, setIsQuitting } from './state';
import { createWindow } from './window';

export function createTray(): void {
  const iconPath = path.join(__dirname, '../../assets/tray-icon.png');
  const icon = nativeImage.createFromPath(iconPath);

  const newTray = new Tray(icon.resize({ width: 16, height: 16 }));
  setTray(newTray);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show PageSpace',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        setIsQuitting(true);
        app.quit();
      },
    },
  ]);

  newTray.setToolTip('PageSpace');
  newTray.setContextMenu(contextMenu);

  newTray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    } else {
      createWindow();
    }
  });
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    setTray(null);
  }
}
