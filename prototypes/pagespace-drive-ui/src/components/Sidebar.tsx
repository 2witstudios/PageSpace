import { useState } from "react";
import type { PageSpaceClient } from "@pagespace/sdk";
import type { DriveRow, PageRow } from "../lib/pagespace";
import { ConfigPopover } from "./ConfigPopover";
import { PageTree } from "./PageTree";

interface SidebarProps {
  width: number;
  apiUrl: string;
  onApiUrlChange: (value: string) => void;
  token: string;
  onTokenChange: (value: string) => void;
  envToken: boolean;
  client: PageSpaceClient | null;
  drives: DriveRow[];
  drivesError: string | null;
  selectedDriveId: string | null;
  onSelectDrive: (driveId: string) => void;
  onDrivesChanged: () => void;
  selectedPageId: string | null;
  onSelectPage: (page: PageRow) => void;
  onMoveRequest: (page: PageRow) => void;
  treeVersion: number;
  showTrash: boolean;
  onToggleTrash: () => void;
}

export function Sidebar({
  width,
  apiUrl,
  onApiUrlChange,
  token,
  onTokenChange,
  envToken,
  client,
  drives,
  drivesError,
  selectedDriveId,
  onSelectDrive,
  onDrivesChanged,
  selectedPageId,
  onSelectPage,
  onMoveRequest,
  treeVersion,
  showTrash,
  onToggleTrash,
}: SidebarProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const selectedDrive = drives.find((d) => d.id === selectedDriveId) ?? null;

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sidebar-top">
        <div className="brand">
          <span className="brand-mark">◆</span>
          <span className="brand-name">Drive UI</span>
        </div>
        <button type="button" className="icon-button" title="Connection settings" onClick={() => setSettingsOpen((v) => !v)}>
          ⚙
        </button>
      </div>

      {settingsOpen && (
        <ConfigPopover
          apiUrl={apiUrl}
          onApiUrlChange={onApiUrlChange}
          token={token}
          onTokenChange={onTokenChange}
          envToken={envToken}
          client={client}
          selectedDrive={selectedDrive}
          onDrivesChanged={onDrivesChanged}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      <div className="drive-switcher">
        <select
          value={selectedDriveId ?? ""}
          onChange={(e) => onSelectDrive(e.target.value)}
          disabled={drives.length === 0}
        >
          {drives.length === 0 && <option value="">No drives</option>}
          {drives.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        {selectedDrive && <span className="drive-role">{selectedDrive.role}</span>}
      </div>

      {drivesError && <p className="error-text">{drivesError}</p>}

      {client && selectedDriveId && (
        <div className="sidebar-tree">
          <PageTree
            key={`${selectedDriveId}-${treeVersion}`}
            client={client}
            driveId={selectedDriveId}
            selectedPageId={selectedPageId}
            onSelect={onSelectPage}
            onMoveRequest={onMoveRequest}
          />
        </div>
      )}

      {client && selectedDriveId && (
        <button type="button" className={`nav-item${showTrash ? " nav-item-active" : ""}`} onClick={onToggleTrash}>
          🗑 Trash
        </button>
      )}
    </aside>
  );
}
