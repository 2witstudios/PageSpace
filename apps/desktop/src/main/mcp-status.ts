import { BrowserWindow } from 'electron';
import { getMCPManager } from './mcp-manager';

let mcpStatusInterval: NodeJS.Timeout | null = null;

function broadcastMCPStatusChange(): void {
  const mcpManager = getMCPManager();
  const statuses = mcpManager.getServerStatuses();

  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send('mcp:status-changed', statuses);
  });
}

export function startMCPStatusBroadcasting(): void {
  if (mcpStatusInterval) return;

  mcpStatusInterval = setInterval(() => {
    broadcastMCPStatusChange();
  }, 3000);
}

export function stopMCPStatusBroadcasting(): void {
  if (mcpStatusInterval) {
    clearInterval(mcpStatusInterval);
    mcpStatusInterval = null;
  }
}

export function triggerMCPStatusBroadcast(): void {
  broadcastMCPStatusChange();
}
