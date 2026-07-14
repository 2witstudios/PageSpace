import { useState } from "react";
import type { PageSpaceClient } from "@pagespace/sdk";
import { describeError, type DriveRow } from "../lib/pagespace";

interface ConfigPopoverProps {
  apiUrl: string;
  onApiUrlChange: (value: string) => void;
  token: string;
  onTokenChange: (value: string) => void;
  envToken: boolean;
  client: PageSpaceClient | null;
  selectedDrive: DriveRow | null;
  onDrivesChanged: () => void;
  onClose: () => void;
}

export function ConfigPopover({
  apiUrl,
  onApiUrlChange,
  token,
  onTokenChange,
  envToken,
  client,
  selectedDrive,
  onDrivesChanged,
  onClose,
}: ConfigPopoverProps) {
  const [renameValue, setRenameValue] = useState(selectedDrive?.name ?? "");
  const [newDriveName, setNewDriveName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rename = async () => {
    if (!client || !selectedDrive || !renameValue.trim() || renameValue.trim() === selectedDrive.name) return;
    setBusy(true);
    setError(null);
    try {
      await client.drives.rename({ driveId: selectedDrive.id, name: renameValue.trim() });
      onDrivesChanged();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const createDrive = async () => {
    if (!client || !newDriveName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await client.drives.create({ name: newDriveName.trim() });
      setNewDriveName("");
      onDrivesChanged();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="config-popover">
      <div className="config-popover-header">
        <h3>Connection</h3>
        <button type="button" className="icon-button" onClick={onClose}>
          ✕
        </button>
      </div>

      <label>
        API URL
        <input value={apiUrl} onChange={(e) => onApiUrlChange(e.target.value)} />
      </label>

      <label>
        Token
        {envToken ? (
          <div className="env-token-badge">
            <span className="badge badge-env">.env.local</span>
            <code>
              {token.slice(0, 8)}…{token.slice(-4)}
            </code>
          </div>
        ) : (
          <input
            type="password"
            value={token}
            onChange={(e) => onTokenChange(e.target.value)}
            placeholder="mcp_..."
          />
        )}
      </label>

      {selectedDrive && (
        <label>
          Rename current drive
          <div className="inline-form">
            <input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  rename();
                }
              }}
            />
            <button type="button" onClick={rename} disabled={busy || !renameValue.trim()}>
              Save
            </button>
          </div>
        </label>
      )}

      <label>
        Create new drive
        <div className="inline-form">
          <input
            value={newDriveName}
            onChange={(e) => setNewDriveName(e.target.value)}
            placeholder="Drive name"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                createDrive();
              }
            }}
          />
          <button type="button" onClick={createDrive} disabled={busy || !newDriveName.trim()}>
            Create
          </button>
        </div>
      </label>

      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
