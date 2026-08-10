import type { Workspace } from "./types";

export const workspaces: Workspace[] = [
  {
    id: "ws-atlas",
    name: "atlas",
    driveId: "drv-pagespace",
    driveName: "PageSpace",
    region: "iad",
    size: "performance-2x · 4 GB",
    status: "ready",
    usage: { cpuPct: 62, memGb: 4, memUsedGb: 2.6, diskGb: 40, diskUsedGb: 21.4 },
    repos: [
      {
        name: "pagespace",
        defaultBranch: "master",
        branches: [
          { name: "pu/webhooks-fanout", agentIds: ["ag-webhooks"] },
          { name: "pu/desktop-logout-fix", agentIds: ["ag-authfix"] },
          { name: "pu/sheetview-decomp", agentIds: ["ag-sheetview"] },
        ],
      },
    ],
  },
  {
    id: "ws-orbit",
    name: "orbit",
    driveId: "drv-pagespace",
    driveName: "PageSpace",
    region: "sjc",
    size: "shared-1x · 2 GB",
    status: "ready",
    usage: { cpuPct: 18, memGb: 2, memUsedGb: 0.9, diskGb: 20, diskUsedGb: 12.8 },
    repos: [
      {
        name: "pagespace",
        defaultBranch: "master",
        branches: [
          { name: "master", agentIds: ["ag-scratch"] },
          { name: "pu/flaky-race-hunt", agentIds: ["ag-flaky"] },
        ],
      },
      {
        name: "pagespace-cli",
        defaultBranch: "main",
        branches: [{ name: "pu/cli-docs", agentIds: ["ag-cli-docs"] }],
      },
    ],
  },
  {
    id: "ws-quarry",
    name: "quarry",
    driveId: "drv-infra",
    driveName: "Infra",
    region: "iad",
    size: "performance-4x · 8 GB",
    status: "stopped",
    usage: { cpuPct: 0, memGb: 8, memUsedGb: 0, diskGb: 80, diskUsedGb: 34.2 },
    repos: [
      {
        name: "pagespace",
        defaultBranch: "master",
        branches: [],
      },
    ],
  },
];

export const workspaceById = (id: string): Workspace | undefined =>
  workspaces.find((w) => w.id === id);
